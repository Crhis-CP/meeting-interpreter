/**
 * Content script (isolated world) in every frame of a meeting page. Relays between the page's
 * microphone hook and the extension's engine, and shows the floating subtitles in the top frame.
 */
import type { TranscriptSegment } from '@core/types';
import { PAGE_TAG, PORT_NAME, type BridgeToMain, type EngineToPage, type MainToBridge, type PageToEngine, type DOmit } from './protocol';

const top = window === window.top;
let hooked = false;
let port: chrome.runtime.Port | null = null;

const toMain = (m: DOmit<BridgeToMain, typeof PAGE_TAG>) => window.postMessage({ [PAGE_TAG]: 'bridge', ...m }, '*');
const send = (m: PageToEngine) => {
  try {
    port?.postMessage(m);
  } catch {
    port = null;
  }
};

function connect() {
  if (port || !(top || hooked)) return;
  try {
    port = chrome.runtime.connect({ name: PORT_NAME });
  } catch {
    return; // extension reloaded: this old content script is orphaned
  }
  port.onMessage.addListener(onEngine);
  port.onDisconnect.addListener(() => {
    port = null;
    // The engine is gone: give the meeting its real microphone back.
    toMain({ t: 'mode', active: false, passthrough: false });
    overlay?.setLive(false);
  });
  send({ t: 'hello', top, micHooked: hooked });
}

function disconnect() {
  port?.disconnect();
  port = null;
  toMain({ t: 'mode', active: false, passthrough: false });
  overlay?.setLive(false);
}

function onEngine(m: EngineToPage) {
  switch (m.t) {
    case 'mode':
      toMain({ t: 'mode', active: m.active, passthrough: m.passthrough });
      if (top) ensureOverlay().setLive(m.active);
      break;
    case 'tts':
      toMain({ t: 'tts', rate: m.rate, pcm: m.pcm });
      break;
    case 'ttsFlush':
      toMain({ t: 'ttsFlush' });
      break;
    case 'seg':
      if (top) ensureOverlay().segment(m.seg, m.mine);
      break;
    case 'partial':
      if (top) ensureOverlay().partial(m.dir, m.text);
      break;
    case 'subtitleStyle':
      if (top) ensureOverlay().style(m.size, m.showMine);
      break;
    case 'notice':
      if (top) ensureOverlay().notice(m.text);
      break;
  }
}

window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  const m = e.data as MainToBridge | undefined;
  if (!m || m[PAGE_TAG] !== 'main') return;
  if (m.t === 'hooked') {
    if (!hooked) {
      hooked = true;
      if (port) send({ t: 'micHooked' });
      else void askRunning();
    }
  } else if (m.t === 'mic') send({ t: 'mic', pcm: m.pcm });
});

chrome.runtime.onMessage.addListener((msg: { type?: string }) => {
  if (msg?.type === 'engine-start') connect();
  else if (msg?.type === 'engine-stop') disconnect();
});

async function askRunning() {
  try {
    const r = (await chrome.runtime.sendMessage({ type: 'bridgeReady' })) as { running?: boolean } | undefined;
    if (r?.running) connect();
  } catch {
    // No service worker answer (extension reloading): nothing to do.
  }
}

toMain({ t: 'ping' });
void askRunning();

// ------------------------------------------------------------------ floating subtitles

interface Overlay {
  setLive(on: boolean): void;
  segment(seg: TranscriptSegment, mine: boolean): void;
  partial(dir: 'out' | 'in', text: string): void;
  style(size: number, showMine: boolean): void;
  notice(text: string): void;
}

let overlay: Overlay | null = null;

function ensureOverlay(): Overlay {
  if (overlay) return overlay;
  const host = document.createElement('div');
  host.id = 'meeting-interpreter-subtitles';
  host.style.cssText = 'position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:2147483647;width:min(820px,86vw);';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
<style>
  .box{font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:rgba(17,24,39,.86);color:#fff;border-radius:14px;
       box-shadow:0 8px 30px rgba(0,0,0,.35);overflow:hidden;user-select:text}
  .bar{display:flex;align-items:center;gap:8px;padding:6px 10px;font-size:12px;color:#cbd5e1;cursor:move;background:rgba(255,255,255,.06)}
  .bar b{color:#fff;font-weight:600}
  .dot{width:8px;height:8px;border-radius:50%;background:#64748b}
  .live .dot{background:#22c55e}
  .sp{flex:1}
  button{all:unset;cursor:pointer;padding:2px 6px;border-radius:6px;color:#e2e8f0}
  button:hover{background:rgba(255,255,255,.12)}
  .lines{padding:8px 14px 12px;max-height:40vh;overflow:auto}
  .line{margin:6px 0}
  .zh{font-size:var(--size,22px);line-height:1.4;font-weight:600}
  .src{font-size:calc(var(--size,22px)*.62);color:#cbd5e1;line-height:1.35}
  .mine .zh{color:#93c5fd;font-size:calc(var(--size,22px)*.75)}
  .partial{color:#fde68a;font-size:calc(var(--size,22px)*.7)}
  .notice{color:#fca5a5;font-size:13px;padding:0 14px 8px}
  .min .lines,.min .notice{display:none}
</style>
<div class="box">
  <div class="bar"><span class="dot"></span><b>会议同传</b><span class="state">未开始</span><span class="sp"></span>
    <button class="smaller" title="字小一点">A-</button><button class="bigger" title="字大一点">A+</button>
    <button class="toggle" title="收起 / 展开">—</button><button class="close" title="隐藏字幕（不影响同传）">✕</button></div>
  <div class="lines"></div>
  <div class="notice"></div>
</div>`;
  const box = root.querySelector('.box') as HTMLDivElement;
  const lines = root.querySelector('.lines') as HTMLDivElement;
  const state = root.querySelector('.state') as HTMLSpanElement;
  const noticeEl = root.querySelector('.notice') as HTMLDivElement;
  let size = 22;
  let showMine = true;
  const partialEl = document.createElement('div');
  partialEl.className = 'line partial';
  const rows = new Map<string, HTMLDivElement>();

  const setSize = (n: number) => {
    size = Math.max(14, Math.min(44, n));
    box.style.setProperty('--size', `${size}px`);
  };
  setSize(size);
  (root.querySelector('.smaller') as HTMLButtonElement).onclick = () => setSize(size - 2);
  (root.querySelector('.bigger') as HTMLButtonElement).onclick = () => setSize(size + 2);
  (root.querySelector('.toggle') as HTMLButtonElement).onclick = () => box.classList.toggle('min');
  (root.querySelector('.close') as HTMLButtonElement).onclick = () => (host.style.display = 'none');

  // Drag by the title bar.
  const bar = root.querySelector('.bar') as HTMLDivElement;
  bar.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).tagName === 'BUTTON') return;
    const r = host.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    const move = (ev: PointerEvent) => {
      host.style.left = `${Math.max(0, ev.clientX - dx)}px`;
      host.style.top = `${Math.max(0, ev.clientY - dy)}px`;
      host.style.bottom = 'auto';
      host.style.transform = 'none';
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  const scroll = () => (lines.scrollTop = lines.scrollHeight);
  const trim = () => {
    while (rows.size > 30) {
      const [id, el] = rows.entries().next().value as [string, HTMLDivElement];
      el.remove();
      rows.delete(id);
    }
  };

  const attach = () => {
    if (!host.isConnected) (document.body ?? document.documentElement).appendChild(host);
  };

  overlay = {
    setLive(on) {
      attach();
      box.classList.toggle('live', on);
      state.textContent = on ? '同传中' : '已停止';
      if (on) host.style.display = '';
      if (!on) partialEl.remove();
    },
    segment(seg, mine) {
      if (mine && !showMine) return;
      attach();
      let row = rows.get(seg.id);
      if (!row) {
        row = document.createElement('div');
        row.className = `line${mine ? ' mine' : ''}`;
        row.innerHTML = '<div class="zh"></div><div class="src"></div>';
        rows.set(seg.id, row);
        lines.insertBefore(row, partialEl.isConnected ? partialEl : null);
        trim();
      }
      // For the other side: Chinese first, original below. For me: what they hear, my words below.
      const main = seg.dstText ?? (seg.status === 'failed' ? `（翻译失败${seg.error ? `：${seg.error.slice(0, 80)}` : ''}）` : '翻译中…');
      (row.querySelector('.zh') as HTMLDivElement).textContent = mine ? `→ ${main}` : main;
      (row.querySelector('.src') as HTMLDivElement).textContent = seg.srcText;
      if (seg.dir === 'in') partialEl.remove();
      scroll();
    },
    partial(dir, text) {
      if (dir === 'out' && !showMine) return;
      attach();
      partialEl.textContent = text ? `${dir === 'out' ? '我：' : ''}${text}` : '';
      if (text) lines.appendChild(partialEl);
      else partialEl.remove();
      scroll();
    },
    style(n, mine) {
      setSize(n);
      showMine = mine;
    },
    notice(text) {
      attach();
      noticeEl.textContent = text;
    },
  };
  return overlay;
}
