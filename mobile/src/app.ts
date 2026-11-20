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
import { accentsOf, lang, REMOTE_CHOICES, withRemoteBase } from '@core/lang/languages';
import { createLogger } from '@core/log';
import { SharedAsr } from '@core/pipeline/conversation';
import { DirectionPipeline } from '@core/pipeline/pipeline';
import { DASHSCOPE_VOICES } from '@core/providers/dashscope/tts';
import { LLM_PRESETS } from '@core/providers/openai-compatible';
import { createProviders } from '@core/providers/registry';
import type { TranscriptSegment } from '@core/types';
import { createMobileContext, keepAwake, native, nativeFetchLarge, openExternal } from './native';
import { OFFLINE_MT_BYTES, OfflineMt } from '../../src/browser/offline-mt/engine';
import { OfflineTranslator } from '@core/providers/offline-translator';
import { emptyProfile, personalFor, ProfileSchema, type VoiceProfile } from '@core/profile/profile';
import { profileJson, profileSummary, readProfileFile } from '../../src/browser/profile-io';
import { checkForUpdate } from '../../src/main/update-check';

declare const __APP_VERSION__: string;
import { createClonedVoice, deleteClonedVoice, waitForVoice } from '@core/providers/dashscope/voice-clone';
import { recordVoiceSample, SAMPLE_SCRIPT, SAMPLE_SECONDS } from '../../src/browser/voice-sample';

// ------------------------------------------------------------------ settings

interface MobileSettings {
  remote: string;
  mode: 'hands-free' | 'ptt';
  provider: 'dashscope' | 'demo';
  mt: 'offline' | 'qwen-mt' | 'llm';
  llmPreset: string;
  voiceForeign: string;
  voiceChinese: string;
  fontSize: number;
  /** “用我的声音”: my cloned voice (百炼) speaks my translations. */
  myVoiceId: string;
  useMyVoice: boolean;
}

const DEFAULTS: MobileSettings = { remote: 'es-MX', mode: 'hands-free', provider: 'dashscope', mt: 'offline', llmPreset: 'zhipu-free', voiceForeign: '', voiceChinese: '', fontSize: 22, myVoiceId: '', useMyVoice: false };
const load = <T>(k: string, d: T): T => {
  try {
    return { ...d, ...(JSON.parse(localStorage.getItem(k) ?? 'null') ?? {}) } as T;
  } catch {
    return d;
  }
};
let settings: MobileSettings = load('mi-settings', DEFAULTS);
/** Opened in a plain browser (the website), not in the Android app: only the demo can run. */
const webOnly = !native();
if (webOnly) settings.provider = 'demo';
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
    dashscope: { region: 'cn', myVoiceId: settings.myVoiceId, useMyVoice: settings.useMyVoice },
  });
}

/** Offline translation (Mozilla models) in this WebView; large downloads go through the app. */
const offline = new OfflineMt({
  workerUrl: new URL('offline-mt/worker.js', location.href).href,
  glueUrl: new URL('offline-mt/bergamot-translator.js', location.href).href,
  wasmUrl: new URL('offline-mt/bergamot-translator.wasm', location.href).href,
  fetchImpl: async (input) => {
    const url = String(input);
    return /^https?:/.test(url) && !url.startsWith(location.origin) ? nativeFetchLarge(url) : fetch(input);
  },
});
let offlineMissing = 0;
void offline.missingBytes().then((n) => (offlineMissing = n)).catch(() => undefined);

/** What still stops the conversation from starting (a missing key), or null. */
function problem(): string | null {
  if (settings.provider === 'demo') return null;
  if (settings.mt === 'offline' && offlineMissing) return `先下载离线翻译（约 ${Math.round(offlineMissing / 1_000_000)} MB，只需一次）`;
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
    const providers = createProviders(s, secrets, pctx, () => [], { offlineMt: { translate: (text, from, to) => offline.translate(text, from, to) } });
    const shared = new SharedAsr(providers.asr('out'), 'zh-CN', settings.remote);
    const t0 = Date.now();
    const draft = settings.mt !== 'offline' && settings.provider !== 'demo' && !(await offline.missingBytes().catch(() => 1)) ? new OfflineTranslator({ translate: (t, f, to) => offline.translate(t, f, to) }) : undefined;
    const make = (side: 'zh' | 'foreign') =>
      new DirectionPipeline({
        dir: side === 'zh' ? 'out' : 'in',
        speaker: side === 'zh' ? 'me' : 'them',
        idPrefix: side === 'zh' ? 'zh' : 'fx',
        srcLang: side === 'zh' ? 'zh-CN' : settings.remote,
        dstLang: side === 'zh' ? settings.remote : 'zh-CN',
        asr: shared.view(side),
        translator: providers.mt(side === 'zh' ? 'out' : 'in'),
        draft,
        tts: providers.tts(side === 'zh' ? 'out' : 'in'),
        voice: (side === 'zh' ? settings.voiceForeign : settings.voiceChinese) || undefined,
        glossary: () => [],
        personal: () => personalFor(profile, side === 'zh' ? 'zh' : lang(settings.remote).base),
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
  return h('div', { class: `turn ${mine ? 'me' : 'them'}` }, h('div', { class: 'main', style: s.draft ? 'opacity:.65' : undefined }, main), h('div', { class: 'src' }, s.srcText));
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
  if (webOnly) list.append(h('div', { class: 'banner' }, '网页版只能演示：说什么都会出现固定的示范句子。真实翻译请用安卓 App，或在电脑上开“现场房间”扫码。'));
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

/** Offline translation models: download once, then translation needs no network. */
function offlineRow(): HTMLElement {
  const status = h('small', {}, offlineMissing ? '只需下载一次' : '✅ 已下载，不联网也能翻译');
  const btn = h('button', {
    class: 'link',
    onclick: async () => {
      btn.disabled = true;
      try {
        await offline.download((p) => (status.textContent = `下载中 ${Math.round((p.received / p.total) * 100)}%`));
        offlineMissing = 0;
        status.textContent = '✅ 已下载，不联网也能翻译';
        btn.remove();
      } catch (err) {
        status.textContent = err instanceof Error ? err.message : String(err);
        btn.disabled = false;
      }
    },
  }, `下载离线翻译（约 ${Math.round((offlineMissing || OFFLINE_MT_BYTES) / 1_000_000)} MB）`);
  return h('div', { class: 'row' }, offlineMissing ? btn : null, status);
}

/** Record 16 s of my voice and clone it with 百炼, so the other side hears my own voice. */
/** The voice profile imported from the desktop app (kept on this phone). */
let profile: VoiceProfile = (() => {
  try {
    const r = ProfileSchema.safeParse(JSON.parse(localStorage.getItem('mi-profile') ?? 'null'));
    return r.success ? r.data : emptyProfile();
  } catch {
    return emptyProfile();
  }
})();

function profileGroup(close: () => void): HTMLElement {
  const status = h('small', {}, `当前：${profileSummary(profile)}`);
  const input = h('input', { type: 'file', accept: '.json,application/json', style: 'display:none' }) as HTMLInputElement;
  input.onchange = async () => {
    const f = input.files?.[0];
    if (!f) return;
    try {
      profile = await readProfileFile(f, profile);
      localStorage.setItem('mi-profile', profileJson(profile));
      status.textContent = `已导入：${profileSummary(profile)}`;
    } catch (err) {
      status.textContent = err instanceof Error ? err.message : String(err);
    }
  };
  return h(
    'div',
    { class: 'group' },
    h('label', { class: 'row' }, h('span', {}, '口音档案'), status, h('small', {}, '在电脑版做口音校准后点“导出”，把 voice-profile.json 传到手机上再导入，识别会按你的口音自动改对。')),
    input,
    h('button', { class: 'link', onclick: () => input.click() }, '导入 voice-profile.json'),
    profile.corrections.length
      ? h('button', { class: 'link', onclick: () => { profile = emptyProfile(); localStorage.removeItem('mi-profile'); close(); } }, '清除口音档案')
      : null,
  );
}

function myVoiceGroup(close: () => void): HTMLElement {
  const status = h('small', {});
  const consent = h('input', { type: 'checkbox', class: 'switch' });
  const rec = h('button', {
    class: 'link',
    onclick: async () => {
      if (!secrets.dashscope) return void (status.textContent = '先填写阿里云百炼 Key');
      if (!consent.checked) return void (status.textContent = '请先打开“这是我本人的声音”');
      rec.disabled = true;
      try {
        const wav = await recordVoiceSample(SAMPLE_SECONDS, (left) => (status.textContent = left ? `正在录音，请朗读上面的文字… ${left} 秒` : '录好了'));
        status.textContent = '正在生成你的音色（约半分钟）…';
        const pctx = createMobileContext(log);
        const cfg = { apiKey: secrets.dashscope, region: 'cn' as const };
        const id = await createClonedVoice(pctx, cfg, wav);
        await waitForVoice(pctx, cfg, id);
        if (settings.myVoiceId) void deleteClonedVoice(pctx, cfg, settings.myVoiceId).catch(() => undefined);
        settings.myVoiceId = id;
        settings.useMyVoice = true;
        close();
      } catch (err) {
        status.textContent = err instanceof Error ? err.message : String(err);
        rec.disabled = false;
      }
    },
  }, settings.myVoiceId ? '重新录制（16 秒）' : '开始录音（16 秒）');
  return h('div', { class: 'group' },
    settings.myVoiceId
      ? h('label', { class: 'row' }, h('span', {}, '对方听到我的声音'), h('input', { type: 'checkbox', class: 'switch', checked: settings.useMyVoice, onchange: (e: Event) => (settings.useMyVoice = (e.target as HTMLInputElement).checked) }))
      : h('div', { class: 'row' }, h('span', {}, '用我的声音'), h('small', {}, '对方听到的翻译用你自己的音色。生成音色免费。')),
    h('div', { class: 'row' }, h('small', {}, '朗读：'), h('span', {}, SAMPLE_SCRIPT)),
    h('label', { class: 'row' }, h('span', {}, '这是我本人的声音，我同意用它合成我的翻译语音'), consent),
    rec,
    status,
  );
}

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
      row('对方说', select(lang(settings.remote).base, REMOTE_CHOICES.map((c) => [c.base, c.name]), (v) => {
        settings.remote = withRemoteBase(settings.remote, v as 'es' | 'en');
        close();
        openSettings();
      })),
      row('口音（一般不用改）', select(settings.remote, accentsOf(lang(settings.remote).base).map((a) => [a.code, a.name]), (v) => (settings.remote = v))),
    ),
    h('div', { class: 'group' },
      row('阿里云百炼 Key', keyInput('dashscope', '粘贴 Key（sk- 开头）')),
      h('button', { class: 'link', onclick: () => openExternal(KEY_URL) }, '去获取 Key ↗'),
      row('翻译', select(settings.mt, [['offline', '离线翻译（免费，最快）'], ['qwen-mt', '百炼翻译'], ['llm', '大模型（可选免费的智谱）']], (v) => {
        settings.mt = v as MobileSettings['mt'];
        close();
        openSettings();
      })),
      settings.mt === 'offline' ? offlineRow() : null,
      settings.mt === 'llm' ? row('大模型', select(settings.llmPreset, LLM_PRESETS.filter((p) => p.id !== 'ollama' && p.id !== 'custom').map((p) => [p.id, p.name]), (v) => (settings.llmPreset = v))) : null,
      settings.mt === 'llm' ? row('大模型 Key', keyInput('llm', '粘贴 Key')) : null,
    ),
    h('div', { class: 'group' },
      row(`对方听到的声音（${foreignName()}）`, select(settings.voiceForeign, voices, (v) => (settings.voiceForeign = v))),
      row('我听到的中文声音', select(settings.voiceChinese, voices, (v) => (settings.voiceChinese = v))),
      row(`字号 ${settings.fontSize}`, h('input', { type: 'range', min: 16, max: 34, value: settings.fontSize, oninput: (e: Event) => (settings.fontSize = Number((e.target as HTMLInputElement).value)) })),
    ),
    myVoiceGroup(close),
    profileGroup(close),
    h('div', { class: 'group' },
      row('演示模式', h('input', { type: 'checkbox', class: 'switch', checked: settings.provider === 'demo', disabled: webOnly, onchange: (e: Event) => (settings.provider = (e.target as HTMLInputElement).checked ? 'demo' : 'dashscope') }), '不用 Key，只看效果'),
    ),
    h('p', { class: 'foot' }, '多人现场开会：在电脑上打开“现场房间”，大家用手机扫码加入。', h('br'), h('a', { href: '#', onclick: (e: Event) => (e.preventDefault(), openExternal('https://crhis-cp.github.io/meeting-interpreter/guide.html#face')) }, '新手上手'), ' · 免费开源 · Key 只保存在这部手机上'),
    ].filter(Boolean) as Node[]),
  );
  document.body.append(sheet);
}

render();

// A quiet note when a newer app is on the download site.
if (!webOnly) {
  void checkForUpdate(__APP_VERSION__, log, createMobileContext(log).fetch).then((u) => {
    if (!u) return;
    const note = h('button', { class: 'banner update', onclick: () => openExternal('https://crhis-cp.github.io/meeting-interpreter/') }, `有新版本 ${u.version}，点这里下载安装`);
    document.body.prepend(note);
  });
}
