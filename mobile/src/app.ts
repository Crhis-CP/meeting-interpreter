/**
 * 会议同传 · 手机版 — face-to-face conversation on one phone.
 *
 * One microphone, two languages: whoever speaks, the phone recognises the language, translates
 * and says it out loud (Chinese → the other language, the other language → Chinese).
 * 免按键: listens all the time; while the phone is speaking it stops listening, so it never
 * translates its own voice. 按住说话: listens only while the big button is held.
 */
import { floatToInt16, int16ToFloat, resampleLinear } from '@core/audio/pcm';
import { parseSettings, type Secrets } from '@core/config/schema';
import { lang, REMOTE_LANGUAGES } from '@core/lang/languages';
import { createLogger } from '@core/log';
import { SharedAsr } from '@core/pipeline/conversation';
import { DirectionPipeline } from '@core/pipeline/pipeline';
import { DASHSCOPE_VOICES } from '@core/providers/dashscope/tts';
import { LLM_PRESETS } from '@core/providers/openai-compatible';
import { createProviders } from '@core/providers/registry';
import type { TranscriptSegment } from '@core/types';
import { createMobileContext, keepAwake, openExternal } from './native';

// ------------------------------------------------------------------ settings

interface MobileSettings {
  remote: string;
  mode: 'hands-free' | 'ptt';
  provider: 'dashscope' | 'demo';
  mt: 'qwen-mt' | 'llm';
  llmPreset: string;
  voiceForeign: string;
  voiceChinese: string;
  fontSize: number;
}

const DEFAULTS: MobileSettings = { remote: 'es-MX', mode: 'hands-free', provider: 'dashscope', mt: 'qwen-mt', llmPreset: 'zhipu-free', voiceForeign: '', voiceChinese: '', fontSize: 22 };
const load = <T>(k: string, d: T): T => {
  try {
    return { ...d, ...(JSON.parse(localStorage.getItem(k) ?? 'null') ?? {}) } as T;
  } catch {
    return d;
  }
};
let settings: MobileSettings = load('mi-settings', DEFAULTS);
let secrets: Secrets = load<Secrets>('mi-secrets', {});
const save = () => {
  localStorage.setItem('mi-settings', JSON.stringify(settings));
  localStorage.setItem('mi-secrets', JSON.stringify(secrets));
};

const KEY_URL = 'https://bailian.console.aliyun.com/?tab=model#/api-key';
const isEn = () => lang(settings.remote).base === 'en';
const foreignName = () => (isEn() ? 'English' : 'Español');

function appSettings() {
  const p = settings.provider;
  const mt = p === 'demo' ? 'demo' : settings.mt;
  return parseSettings({
    onboarded: true,
    preset: p === 'demo' ? 'demo' : 'custom',
    languages: { self: 'zh-CN', remote: settings.remote },
    out: { enabled: true, asr: p, mt, tts: p, voice: settings.voiceForeign },
    in: { enabled: true, asr: p, mt, tts: p, voice: settings.voiceChinese },
    llm: { preset: settings.llmPreset, baseUrl: '', model: '', summaryModel: '' },
    interpretation: { lowLatency: true, pinyinFuzzy: true },
  });
}

/** What still stops the conversation from starting (a missing key), or null. */
function problem(): string | null {
  if (settings.provider === 'demo') return null;
  if (!secrets.dashscope) return '先填写阿里云百炼 Key';
  if (settings.mt === 'llm' && !secrets.llm) return '先填写翻译大模型的 Key';
  return null;
}

// ------------------------------------------------------------------ engine

const log = createLogger('mobile');

interface Engine {
  out: DirectionPipeline;
  inn: DirectionPipeline;
  ctx: AudioContext;
  stream: MediaStream;
  nodes: AudioNode[];
  playingUntil: number;
  sources: Set<AudioBufferSourceNode>;
  startedAt: number;
}

let engine: Engine | null = null;
let held = false;
let status: 'idle' | 'starting' | 'listening' | 'speaking' | 'error' = 'idle';
let statusText = '';
const segs = new Map<string, TranscriptSegment>();
let partial = '';

/** While the phone is talking (and a moment after), the microphone is ignored. */
const TAIL_S = 0.35;
const phoneTalking = (e: Engine) => e.ctx.currentTime < e.playingUntil + TAIL_S;

async function start() {
  if (engine || status === 'starting') return;
  const why = problem();
  if (why) return openSettings(why);
  status = 'starting';
  render();
  try {
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    await ctx.resume();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    const s = appSettings();
    const pctx = createMobileContext(log);
    const providers = createProviders(s, secrets, pctx, () => []);
    const shared = new SharedAsr(providers.asr('out'), 'zh-CN', settings.remote);
    const t0 = Date.now();
    const make = (side: 'zh' | 'foreign') =>
      new DirectionPipeline({
        dir: side === 'zh' ? 'out' : 'in',
        speaker: side === 'zh' ? 'me' : 'them',
        idPrefix: side === 'zh' ? 'zh' : 'fx',
        srcLang: side === 'zh' ? 'zh-CN' : settings.remote,
        dstLang: side === 'zh' ? settings.remote : 'zh-CN',
        asr: shared.view(side),
        translator: providers.mt(side === 'zh' ? 'out' : 'in'),
        tts: providers.tts(side === 'zh' ? 'out' : 'in'),
        voice: (side === 'zh' ? settings.voiceForeign : settings.voiceChinese) || undefined,
        glossary: () => [],
        pinyinFuzzy: true,
        lowLatency: true,
        clock: () => (Date.now() - t0) / 1000,
        idleCloseMs: 0,
        log: log.child(side),
      });
    const out = make('zh');
    const inn = make('foreign');
    const e: Engine = { out, inn, ctx, stream, nodes: [], playingUntil: 0, sources: new Set(), startedAt: t0 };
    for (const p of [out, inn]) {
      p.on('segment', (seg) => {
        segs.set(seg.id, seg);
        partial = '';
        render();
      });
      p.on('partial', ({ text }) => {
        partial = text;
        renderPartial();
      });
      p.on('status', ({ state, message }) => {
        if (state === 'error') {
          status = 'error';
          statusText = message ?? '出错了';
          render();
        }
      });
      p.on('audio', ({ samples, sampleRate }) => play(e, samples, sampleRate));
    }
    // Microphone → 16 kHz → the shared recogniser (unless the phone is talking or the button is up).
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    src.connect(proc).connect(mute).connect(ctx.destination);
    proc.onaudioprocess = (ev) => {
      const listening = settings.mode === 'hands-free' ? !phoneTalking(e) : held;
      if (!listening) return;
      out.push(floatToInt16(resampleLinear(ev.inputBuffer.getChannelData(0), ctx.sampleRate, 16000)));
    };
    e.nodes = [src, proc, mute];
    engine = e;
    await Promise.all([out.start(), inn.start()]);
    out.setGate(settings.mode === 'hands-free' || held);
    status = 'listening';
    statusText = '';
    keepAwake(true);
  } catch (err) {
    await stop();
    status = 'error';
    statusText = err instanceof Error ? err.message : String(err);
    if (/Permission|NotAllowed/i.test(statusText)) statusText = '需要麦克风权限：请在系统设置里允许本应用使用麦克风';
  }
  render();
}

async function stop() {
  const e = engine;
  engine = null;
  held = false;
  keepAwake(false);
  if (!e) {
    status = 'idle';
    return render();
  }
  for (const s of e.sources) {
    try {
      s.stop();
    } catch {
      // already stopped
    }
  }
  for (const n of e.nodes) n.disconnect();
  for (const t of e.stream.getTracks()) t.stop();
  await Promise.all([e.out.stop(2000).catch(() => undefined), e.inn.stop(2000).catch(() => undefined)]);
  await e.ctx.close().catch(() => undefined);
  status = 'idle';
  render();
}

function play(e: Engine, samples: Int16Array, rate: number) {
  if (engine !== e || !samples.length) return;
  const f = int16ToFloat(samples);
  const buf = e.ctx.createBuffer(1, f.length, rate);
  buf.copyToChannel(f as Float32Array<ArrayBuffer>, 0);
  const src = e.ctx.createBufferSource();
  src.buffer = buf;
  src.connect(e.ctx.destination);
  const at = Math.max(e.ctx.currentTime + 0.03, e.playingUntil);
  src.start(at);
  e.playingUntil = at + buf.duration;
  e.sources.add(src);
  status = 'speaking';
  renderStatus();
  src.onended = () => {
    e.sources.delete(src);
    if (!e.sources.size && engine === e) {
      status = 'listening';
      renderStatus();
    }
  };
  const backlog = Math.max(0, e.playingUntil - e.ctx.currentTime);
  e.out.setBacklog(backlog);
  e.inn.setBacklog(backlog);
}

function setHeld(on: boolean) {
  held = on;
  engine?.out.setGate(on);
  renderStatus();
}

// ------------------------------------------------------------------ UI

type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === false || v === null) continue;
    if (k === 'class') el.className = String(v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k in el) (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

const app = document.getElementById('app')!;
let list: HTMLDivElement;
let partialEl: HTMLDivElement;
let statusEl: HTMLDivElement;

function statusLine(): string {
  if (status === 'error') return statusText;
  if (status === 'starting') return '正在连接…';
  if (!engine) return settings.mode === 'hands-free' ? '点下面的按钮开始，双方直接说话' : '按住按钮说话，松开就翻译';
  if (status === 'speaking') return '正在播放翻译…';
  if (settings.mode === 'ptt') return held ? '正在听…松开就翻译' : '按住按钮说话（谁说都行）';
  return '正在听，谁说都行';
}

function renderStatus() {
  if (statusEl) {
    statusEl.textContent = statusLine();
    statusEl.className = `status ${status}`;
  }
  document.body.dataset.state = engine ? (status === 'speaking' ? 'speaking' : settings.mode === 'ptt' && !held ? 'idle' : 'listening') : 'off';
}

function renderPartial() {
  if (!partialEl) return;
  partialEl.textContent = partial;
  partialEl.hidden = !partial;
  list.scrollTop = list.scrollHeight;
}

function bubble(s: TranscriptSegment) {
  const mine = s.speaker === 'me';
  const main = s.dstText ?? (s.status === 'failed' ? '（翻译失败）' : '…');
  return h('div', { class: `turn ${mine ? 'me' : 'them'}` }, h('div', { class: 'main' }, main), h('div', { class: 'src' }, s.srcText));
}

function render() {
  document.documentElement.style.setProperty('--font', `${settings.fontSize}px`);
  const toggleLang = () => {
    if (engine) return;
    settings.remote = isEn() ? 'es-MX' : 'en-US';
    save();
    render();
  };
  list = h('div', { class: 'list' });
  const turns = [...segs.values()].sort((a, b) => a.start - b.start);
  if (!turns.length) list.append(h('div', { class: 'empty' }, h('div', { class: 'hello' }, '你好 · ', isEn() ? 'Hello' : 'Hola'), h('div', {}, '把手机放在你们中间，直接说话。'), h('div', {}, '中文会翻成', isEn() ? '英语' : '西班牙语', '，对方的话会翻成中文。')));
  for (const s of turns) list.append(bubble(s));
  partialEl = h('div', { class: 'partial' });
  list.append(partialEl);

  const mic =
    settings.mode === 'hands-free'
      ? h('button', { class: 'mic', 'aria-label': engine ? '暂停' : '开始', onclick: () => void (engine ? stop() : start()) }, h('span', { class: 'ring' }), micIcon(), h('span', { class: 'cap' }, engine ? '暂停' : '开始对话'))
      : h(
          'button',
          {
            class: 'mic',
            'aria-label': '按住说话',
            onpointerdown: async (ev: PointerEvent) => {
              (ev.target as HTMLElement).setPointerCapture?.(ev.pointerId);
              if (!engine) await start();
              setHeld(true);
            },
            onpointerup: () => setHeld(false),
            onpointercancel: () => setHeld(false),
            oncontextmenu: (ev: Event) => ev.preventDefault(),
          },
          h('span', { class: 'ring' }),
          micIcon(),
          h('span', { class: 'cap' }, '按住说话'),
        );

  statusEl = h('div', { class: 'status' });
  app.replaceChildren(
    h('header', {},
      h('button', { class: 'pill', onclick: toggleLang, disabled: !!engine }, '中文 ⇄ ', foreignName()),
      h('div', { class: 'grow' }),
      turns.length && !engine ? h('button', { class: 'icon-btn', 'aria-label': '清空', onclick: () => (segs.clear(), render()) }, '清空') : null,
      h('button', { class: 'icon-btn', 'aria-label': '设置', onclick: () => openSettings() }, gearIcon()),
    ),
    list,
    h('footer', {},
      statusEl,
      mic,
      h('div', { class: 'seg' },
        h('button', { class: settings.mode === 'hands-free' ? 'on' : '', onclick: () => setMode('hands-free') }, '免按键'),
        h('button', { class: settings.mode === 'ptt' ? 'on' : '', onclick: () => setMode('ptt') }, '按住说话'),
      ),
    ),
  );
  renderStatus();
  renderPartial();
}

function setMode(m: MobileSettings['mode']) {
  settings.mode = m;
  save();
  held = false;
  engine?.out.setGate(m === 'hands-free');
  render();
}

const svg = (d: string, size = 30) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('width', String(size));
  el.setAttribute('height', String(size));
  el.innerHTML = d;
  return el;
};
const micIcon = () => svg('<rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>', 34);
const gearIcon = () => svg('<path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7.4-3a7.4 7.4 0 0 0-.1-1.3l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-2.2-1.3L14.4 3h-4l-.4 2.4a7.5 7.5 0 0 0-2.2 1.3l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.6l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 0 0 2.2 1.3l.4 2.4h4l.4-2.4a7.5 7.5 0 0 0 2.2-1.3l2.4 1 2-3.4-2-1.6c.1-.4.1-.9.1-1.3z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>', 22);

// ------------------------------------------------------------------ settings sheet

function openSettings(hint?: string) {
  const sheet = h('div', { class: 'sheet' });
  const close = () => {
    save();
    sheet.remove();
    render();
  };
  const row = (label: string, control: Node, note?: string) => h('label', { class: 'row' }, h('span', {}, label), control, note ? h('small', {}, note) : null);
  const select = (value: string, opts: [string, string][], on: (v: string) => void) =>
    h('select', { onchange: (e: Event) => on((e.target as HTMLSelectElement).value) }, ...opts.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
  const keyInput = (name: keyof Secrets, placeholder: string) =>
    h('input', { type: 'password', value: secrets[name] ?? '', placeholder, autocomplete: 'off', oninput: (e: Event) => (secrets = { ...secrets, [name]: (e.target as HTMLInputElement).value.trim() || undefined }) });
  const voices: [string, string][] = [['', '默认'], ...DASHSCOPE_VOICES.map((v) => [v.id, v.name] as [string, string])];

  sheet.append(
    ...([
    h('div', { class: 'sheet-head' }, h('b', {}, '设置'), h('button', { class: 'done', onclick: close }, '完成')),
    hint ? h('div', { class: 'hint' }, hint) : null,
    h('div', { class: 'group' },
      row('对方说', select(settings.remote, REMOTE_LANGUAGES.map((c) => [c, lang(c).nameZh]), (v) => (settings.remote = v))),
    ),
    h('div', { class: 'group' },
      row('阿里云百炼 Key', keyInput('dashscope', '粘贴 Key（sk- 开头）')),
      h('button', { class: 'link', onclick: () => openExternal(KEY_URL) }, '去获取 Key ↗'),
      row('翻译', select(settings.mt, [['qwen-mt', '百炼翻译（快）'], ['llm', '大模型（可选免费的智谱）']], (v) => {
        settings.mt = v as MobileSettings['mt'];
        close();
        openSettings();
      })),
      settings.mt === 'llm' ? row('大模型', select(settings.llmPreset, LLM_PRESETS.filter((p) => p.id !== 'ollama' && p.id !== 'custom').map((p) => [p.id, p.name]), (v) => (settings.llmPreset = v))) : null,
      settings.mt === 'llm' ? row('大模型 Key', keyInput('llm', '粘贴 Key')) : null,
    ),
    h('div', { class: 'group' },
      row(`对方听到的声音（${foreignName()}）`, select(settings.voiceForeign, voices, (v) => (settings.voiceForeign = v))),
      row('我听到的中文声音', select(settings.voiceChinese, voices, (v) => (settings.voiceChinese = v))),
      row(`字号 ${settings.fontSize}`, h('input', { type: 'range', min: 16, max: 34, value: settings.fontSize, oninput: (e: Event) => (settings.fontSize = Number((e.target as HTMLInputElement).value)) })),
    ),
    h('div', { class: 'group' },
      row('演示模式', h('input', { type: 'checkbox', class: 'switch', checked: settings.provider === 'demo', onchange: (e: Event) => (settings.provider = (e.target as HTMLInputElement).checked ? 'demo' : 'dashscope') }), '不用 Key，只看效果'),
    ),
    h('p', { class: 'foot' }, '多人现场开会：在电脑上打开“现场房间”，大家用手机扫码加入。', h('br'), '免费开源 · Key 只保存在这部手机上'),
    ].filter(Boolean) as Node[]),
  );
  document.body.append(sheet);
}

render();
