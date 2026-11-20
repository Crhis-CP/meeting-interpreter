import type { Secrets } from '@core/config/schema';
import { glossaryToCsv, parseGlossaryCsv } from '@core/glossary/csv';
import { newEntryId, type GlossaryEntry } from '@core/glossary/types';
import { accentsOf, baseOf, lang, REMOTE_CHOICES, withRemoteBase } from '@core/lang/languages';
import { azureVoicesFor } from '@core/providers/azure/common';
import { DASHSCOPE_VOICES } from '@core/providers/dashscope/tts';
import { LLM_PRESETS } from '@core/providers/openai-compatible';
import { makeLlm } from '@core/providers/registry';
import { summarize, summaryToMarkdown, TEMPLATE_NAMES, type MeetingSummary, type SummaryTemplate } from '@core/session/summary';
import { toMarkdown, toSrt } from '@core/session/transcript';
import { testDirection } from '../../src/main/provider-test';
import { createClonedVoice, deleteClonedVoice, waitForVoice } from '@core/providers/dashscope/voice-clone';
import { recordVoiceSample, SAMPLE_SCRIPT, SAMPLE_SECONDS } from '../../src/browser/voice-sample';
import { consoleLogger, createBrowserContext } from './browser-context';
import { buildProviders, offlineMt, usesDesktop } from './engine-providers';
import { DESKTOP_BRIDGE_PORT, pingDesktop } from '@core/bridge/desktop';
import { desktopMissing, h, keyField, seg, settingsProblem } from './dom';
import { profileJson, profileSummary, readProfileFile } from '../../src/browser/profile-io';
import { emptyProfile } from '@core/profile/profile';
import { KEY_LINKS, loadAll, missingKey, PLAN_NAMES, toAppSettings, withDefaults, type ExtSettings, type ProviderSet, type SavedMeeting } from './shared';

const app = document.getElementById('app')!;
let tab: 'settings' | 'glossary' | 'meetings' = 'settings';
let openMeeting: string | null = null;
/** The tabs are links: #glossary, #meetings, #meeting=<id>; anything else is the settings tab. */
function readHash() {
  const m = /meeting=([^&]+)/.exec(location.hash);
  openMeeting = m ? decodeURIComponent(m[1]!) : null;
  tab = m || location.hash === '#meetings' ? 'meetings' : location.hash === '#glossary' ? 'glossary' : 'settings';
}
readHash();
window.addEventListener('hashchange', () => {
  readHash();
  void render();
});

const addHeaders = async (url: string, headers: Record<string, string>) => {
  const r = (await chrome.runtime.sendMessage({ target: 'background', type: 'wsHeaders', url, headers })) as { ok?: boolean; error?: string } | undefined;
  if (!r?.ok) throw new Error(r?.error ?? '无法设置连接参数');
};
const ctx = () => createBrowserContext(consoleLogger('options'), addHeaders);

async function saveSettings(patch: Partial<ExtSettings>) {
  const { settings } = await loadAll();
  await chrome.storage.local.set({ settings: withDefaults({ ...settings, ...patch }) });
}

function download(name: string, text: string, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob(['﻿', text], { type: `${type};charset=utf-8` }));
  h('a', { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function render() {
  const body = h('main');
  app.replaceChildren(
    h('header', { class: 'row between', style: 'margin-bottom:20px' },
      h('h1', { class: 'row' }, h('img', { src: 'icons/icon-48.png', width: 32, height: 32, alt: '' }), '会议同传'),
      h('nav', { class: 'seg', style: 'width:420px;margin:0', 'aria-label': '页面' },
        ...(
          [
            ['settings', '#settings', '服务与语言'],
            ['glossary', '#glossary', '术语表'],
            ['meetings', '#meetings', '会议记录'],
          ] as const
        ).map(([k, href, label]) => h('a', { href, 'aria-current': tab === k ? 'page' : false }, label)),
      ),
      h('span', { class: 'muted small' }, `v${chrome.runtime.getManifest().version}`),
    ),
    body,
  );
  if (tab === 'settings') await renderSettings(body);
  else if (tab === 'glossary') await renderGlossary(body);
  else await renderMeetings(body);
}

// ------------------------------------------------------------------ settings

const PLANS: ProviderSet[] = ['free', 'dashscope', 'azure', 'custom', 'demo'];

function secretInput(secrets: Secrets, name: keyof Secrets, label: string, link?: string) {
  return keyField(name, label, !!secrets[name], link, async (v) => {
    const { secrets: cur } = await loadAll();
    await chrome.storage.local.set({ secrets: { ...cur, [name]: v || undefined } });
    void render();
  });
}

function select(value: string, options: [string, string][], onchange: (v: string) => void, label?: string) {
  return h('select', { 'aria-label': label, onchange: (e: Event) => onchange((e.target as HTMLSelectElement).value) }, ...options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
}

function voiceOptions(tts: string, code: string): [string, string][] {
  const list = tts === 'dashscope' ? DASHSCOPE_VOICES.map((v) => [v.id, v.name] as [string, string]) : tts === 'azure' ? azureVoicesFor(code).map((v) => [v.id, v.name] as [string, string]) : [];
  return [['', '默认'], ...list];
}

const field = (label: string, control: Node) => h('label', { class: 'field' }, h('span', {}, label), control);
const textField = (label: string, value: string, onchange: (v: string) => void) =>
  field(label, h('input', { type: 'text', value, onchange: (e: Event) => onchange((e.target as HTMLInputElement).value.trim()) }));

async function renderSettings(body: HTMLElement) {
  const data = await loadAll();
  const { settings: s, secrets } = data;
  const problem = settingsProblem(data);
  const set = async (patch: Partial<ExtSettings>) => {
    await saveSettings(patch);
    void render();
  };
  const uses = (p: string) => [s.out.asr, s.out.mt, s.out.tts, s.in.asr, s.in.mt, s.in.tts].includes(p);

  // ---- the essentials, in the order they are set up: language, plan, what the plan needs, test
  const main = h('section', { class: 'card stack', 'aria-label': '服务与语言' });
  main.append(
    h('div', { class: 'pair' },
      h('span', { 'aria-hidden': 'true' }, '中文 ⇄'),
      seg('对方说', REMOTE_CHOICES.map((c) => [c.base, c.name] as const), baseOf(s.remote) as 'es' | 'en', (v) => void set({ remote: withRemoteBase(s.remote, v), out: { ...s.out, voice: '' } })),
      select(s.remote, accentsOf(baseOf(s.remote)).map((a) => [a.code, a.name]), (v) => void set({ remote: v, out: { ...s.out, voice: '' } }), '口音'),
    ),
    seg('方案', PLANS.map((p) => [p, PLAN_NAMES[p]] as const), s.providers, (v) => void set({ providers: v })),
  );
  if (s.providers === 'custom') {
    for (const d of ['out', 'in'] as const) {
      const c = s[d];
      const upd = (patch: Partial<ExtSettings['out']>) => void set({ [d]: { ...c, ...patch } } as Partial<ExtSettings>);
      main.append(
        h('fieldset', {},
          h('legend', {}, d === 'out' ? '我说话' : '对方说话'),
          h('div', { class: 'grid3' },
            field('识别', select(c.asr, [['local', '本机（桌面客户端，免费）'], ['dashscope', '阿里云百炼'], ['azure', 'Azure'], ['demo', '演示']], (v) => upd({ asr: v }))),
            field('翻译', select(c.mt, [['local-ai', '本机 AI 翻译（桌面客户端，免费）'], ['offline', '离线翻译（免费）'], ['llm', '大模型'], ['qwen-mt', '百炼翻译'], ['deepl', 'DeepL'], ['azure-translator', 'Azure 翻译'], ['demo', '演示']], (v) => upd({ mt: v }))),
            field('发音', select(c.tts, [['system', '电脑自带声音（免费）'], ['dashscope', '阿里云百炼'], ['azure', 'Azure'], ['none', '不发音'], ['demo', '演示']], (v) => upd({ tts: v }))),
          ),
        ),
      );
    }
  }
  if (uses('llm')) {
    main.append(field('大模型', select(s.llm.preset, LLM_PRESETS.map((p) => [p.id, p.name]), (v) => void set({ llm: { ...s.llm, preset: v, baseUrl: '', model: '' } }))));
    if (s.llm.preset === 'custom') {
      main.append(
        h('div', { class: 'grid3' },
          textField('接口地址', s.llm.baseUrl, (v) => void set({ llm: { ...s.llm, baseUrl: v } })),
          textField('模型名', s.llm.model, (v) => void set({ llm: { ...s.llm, model: v } })),
        ),
        s.llm.baseUrl
          ? h('button', {
              class: 'btn',
              onclick: async () => {
                try {
                  const ok = await chrome.permissions.request({ origins: [`${new URL(s.llm.baseUrl).origin}/*`] });
                  alert(ok ? '已允许插件访问这个接口地址。' : '没有授权，插件无法访问这个接口地址。');
                } catch (err) {
                  alert(`接口地址不正确：${err instanceof Error ? err.message : String(err)}`);
                }
              },
            }, '允许插件访问这个地址')
          : '',
      );
    }
  }
  // Only the keys the chosen services need.
  if (s.providers === 'free' || uses('llm')) {
    const zhipu = s.llm.preset === 'zhipu-free';
    main.append(secretInput(secrets, 'llm', zhipu ? KEY_LINKS.llm.label : '大模型 Key', zhipu ? KEY_LINKS.llm.url : undefined));
  }
  if (uses('dashscope') || uses('qwen-mt') || (uses('llm') && s.llm.preset === 'qwen')) main.append(secretInput(secrets, 'dashscope', KEY_LINKS.dashscope.label, KEY_LINKS.dashscope.url));
  if (uses('azure')) main.append(secretInput(secrets, 'azure', 'Azure 语音 Key', 'https://portal.azure.com/#create/Microsoft.CognitiveServicesSpeechServices'));
  if (uses('azure-translator')) main.append(secretInput(secrets, 'azureTranslator', 'Azure 翻译 Key', 'https://portal.azure.com/#create/Microsoft.CognitiveServicesTextTranslation'));
  if (uses('deepl')) main.append(secretInput(secrets, 'deepl', 'DeepL Key', 'https://www.deepl.com/pro-api'));
  if (usesDesktop(s)) {
    const st = h('div', { class: 'muted small', role: 'status' }, '正在检查桌面客户端…');
    main.append(st);
    void pingDesktop(ctx()).then((p) => {
      if (!p) return st.replaceWith(desktopMissing());
      st.replaceChildren(h('span', { class: 'badge' }, `桌面客户端已连接（${p.version}）`));
      if (uses('local-ai')) st.append(' ', p.ai ? h('span', { class: 'badge' }, '本机 AI 翻译可用') : '本机 AI 翻译未下载（桌面客户端 › 设置 › 翻译服务）');
    });
  }
  if (uses('offline') || uses('local-ai')) main.append(offlineMtRow());
  if (problem && !missingKey(s, secrets)) main.append(h('div', { class: 'callout warn', role: 'status' }, problem));

  const results = h('div', { class: 'stack', role: 'status' });
  main.append(
    h('button', {
      id: 'test',
      class: 'big',
      disabled: !!problem,
      onclick: async (e: Event) => {
        const btn = e.target as HTMLButtonElement;
        btn.disabled = true;
        btn.textContent = '测试中…';
        results.replaceChildren();
        try {
          const d = await loadAll();
          const settings = toAppSettings(d.settings);
          const p = buildProviders(d.settings, d.secrets, ctx(), () => d.glossary);
          const steps = [
            ...(await testDirection(p, 'out', 'zh-CN', settings.languages.remote)),
            ...(await testDirection(p, 'in', settings.languages.remote, 'zh-CN')),
          ];
          const ok = steps.every((x) => x.ok);
          results.append(
            h('div', { class: `callout ${ok ? 'info' : 'err'}` }, ok ? '一切正常，可以开会了' : '测试没通过'),
            h('ul', { class: 'plain stack small' },
              ...steps.map((x) => h('li', {}, h('span', { role: 'img', 'aria-label': x.ok ? '通过' : '失败' }, x.ok ? '✅' : '❌'), ` ${x.name}`, h('span', { class: 'muted' }, ` ${x.detail}`))),
            ),
          );
        } catch (err) {
          results.append(h('div', { class: 'callout err', role: 'alert' }, err instanceof Error ? err.message : String(err)));
        } finally {
          btn.disabled = false;
          btn.textContent = '测试一下';
        }
      },
    }, '测试一下'),
    results,
  );
  body.append(main);
  if (s.out.tts === 'dashscope' && secrets.dashscope) body.append(myVoiceCard(s, set));

  // ---- preferences, folded away
  const more = h('details', { class: 'card' }, h('summary', {}, '更多设置'));
  const moreBody = h('div', { class: 'stack', style: 'margin-top:10px' });
  more.append(moreBody);
  if (uses('dashscope') || uses('qwen-mt')) moreBody.append(field('百炼地域', select(s.dashscopeRegion, [['cn', '中国（北京）'], ['intl', '国际（新加坡）']], (v) => void set({ dashscopeRegion: v as 'cn' | 'intl' }))));
  if (uses('azure')) moreBody.append(textField('Azure 语音区域', s.azureRegion, (v) => void set({ azureRegion: v })));
  if (uses('azure-translator')) moreBody.append(textField('Azure 翻译区域', s.azureTranslatorRegion, (v) => void set({ azureTranslatorRegion: v })));
  moreBody.append(
    s.out.tts === 'dashscope' || s.out.tts === 'azure'
      ? field('对方听到的声音', select(s.out.voice, voiceOptions(s.out.tts, s.remote), (v) => void set({ out: { ...s.out, voice: v } })))
      : s.out.tts === 'system'
        ? systemVoiceSelect(s, set)
        : '',
    toggle(s.playOriginal, '听对方的原声', (v) => set({ playOriginal: v })),
    toggle(s.speakIn, '用中文读出对方的话', (v) => set({ speakIn: v })),
    toggle(s.showMine, '字幕里显示我说的话', (v) => set({ showMine: v })),
    toggle(s.pinyinFuzzy, '术语近音纠错', (v) => set({ pinyinFuzzy: v })),
    field(`字幕字号 ${s.subtitleSize}`, h('input', { type: 'range', min: 14, max: 40, value: s.subtitleSize, onchange: (e: Event) => void set({ subtitleSize: Number((e.target as HTMLInputElement).value) }) })),
  );
  body.append(more);
  body.append(await profileCard());
  if (location.hash === '#test') document.getElementById('test')?.scrollIntoView();
}

/** The voice profile from the desktop app: import, export, clear. */
async function profileCard(): Promise<HTMLElement> {
  const { profile } = await loadAll();
  const msg = h('span', { class: 'muted small', role: 'alert' });
  const input = h('input', { type: 'file', accept: '.json,application/json', style: 'display:none' }) as HTMLInputElement;
  input.onchange = async () => {
    const f = input.files?.[0];
    if (!f) return;
    try {
      const next = await readProfileFile(f, (await loadAll()).profile);
      await chrome.storage.local.set({ voiceProfile: next });
      void render();
    } catch (err) {
      msg.textContent = err instanceof Error ? err.message : String(err);
    }
  };
  return h('section', { class: 'card stack', id: 'profile', 'aria-labelledby': 'profile-title' },
    h('div', { class: 'row' }, h('h2', { id: 'profile-title' }, '口音档案'), h('span', { class: 'muted', role: 'status' }, profileSummary(profile))),
    h('div', { class: 'row' },
      input,
      h('button', { class: 'btn', onclick: () => input.click() }, '从电脑版导入'),
      profile.corrections.length ? h('button', { class: 'btn', onclick: () => download('voice-profile.json', profileJson(profile), 'application/json') }, '导出') : '',
      profile.corrections.length ? h('button', { class: 'btn', onclick: async () => { if (confirm('清除口音档案？')) { await chrome.storage.local.set({ voiceProfile: emptyProfile() }); void render(); } } }, '清除') : '',
      msg,
    ),
  );
}

/** “用我的声音”: record 16 s, clone it with 百炼, and let the other side hear my own voice. */
function myVoiceCard(s: ExtSettings, set: (p: Partial<ExtSettings>) => Promise<void>) {
  const status = h('span', { class: 'muted small', role: 'status' });
  const recordBtn = h('button', {
    class: 'btn primary',
    disabled: true,
    onclick: async () => {
      recordBtn.disabled = true;
      try {
        const wav = await recordVoiceSample(SAMPLE_SECONDS, (left) => (status.textContent = left ? `正在录音… ${left} 秒` : '录好了'));
        status.textContent = '正在生成你的音色…';
        const { secrets } = await loadAll();
        const cfg = { apiKey: secrets.dashscope ?? '', region: s.dashscopeRegion };
        const id = await createClonedVoice(ctx(), cfg, wav);
        await waitForVoice(ctx(), cfg, id);
        if (s.myVoiceId) void deleteClonedVoice(ctx(), cfg, s.myVoiceId).catch(() => undefined);
        await set({ myVoiceId: id, useMyVoice: true });
      } catch (err) {
        status.textContent = err instanceof Error ? err.message : String(err);
        recordBtn.disabled = false;
      }
    },
  }, '开始录音（16 秒）');
  // Read the text, agree, record: in that order. Recording waits for the consent.
  const consent: HTMLInputElement = h('input', { type: 'checkbox', onchange: () => (recordBtn.disabled = !consent.checked) });
  const recorder = h('div', { class: 'stack' },
    h('blockquote', { class: 'callout info', lang: 'zh-CN', style: 'margin:0;font-size:15px;line-height:1.7' }, SAMPLE_SCRIPT),
    h('label', { class: 'check small' }, consent, '这是我本人的声音，我同意用它合成我的翻译语音'),
    h('div', { class: 'row' }, recordBtn, status),
  );
  return h('section', { class: 'card stack', 'aria-labelledby': 'myvoice-title' },
    h('div', { class: 'row between' }, h('h2', { id: 'myvoice-title' }, '用我的声音'), s.myVoiceId ? toggle(s.useMyVoice, '对方听到我的声音', (v) => set({ useMyVoice: v })) : ''),
    s.myVoiceId ? h('details', {}, h('summary', {}, '重新录制'), recorder) : recorder,
  );
}

/** Offline translation models: status and one-click download (kept in this browser). */
function offlineMtRow(): HTMLElement {
  const row = h('div', { class: 'stack' });
  const render = async () => {
    const missing = await offlineMt().missingBytes();
    if (!missing) return row.replaceChildren(h('span', { class: 'badge', role: 'status' }, '离线翻译已下载'));
    const status = h('span', { class: 'muted small', role: 'status' });
    const btn = h('button', {
      class: 'btn primary',
      onclick: async () => {
        btn.disabled = true;
        try {
          await offlineMt().download((p) => (status.textContent = `下载中 ${Math.round((p.received / p.total) * 100)}%`));
          void render();
        } catch (err) {
          status.textContent = err instanceof Error ? err.message : String(err);
          btn.disabled = false;
        }
      },
    }, `下载离线翻译（约 ${Math.round(missing / 1_000_000)} MB）`);
    row.replaceChildren(h('div', { class: 'row' }, btn, status));
    if (location.hash === '#offline') btn.click();
  };
  void render();
  return row;
}

/** Voices installed on the computer, listed by the desktop app. */
function systemVoiceSelect(s: ExtSettings, set: (p: Partial<ExtSettings>) => Promise<void>) {
  const sel = select(s.out.voice, [['', '默认']], (v) => void set({ out: { ...s.out, voice: v } }));
  const wrap = field('对方听到的声音', sel);
  void (async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${DESKTOP_BRIDGE_PORT}/voices?lang=${encodeURIComponent(s.remote)}`);
      const voices = (await res.json()) as { id: string; name: string }[];
      for (const v of voices) sel.append(h('option', { value: v.id, selected: v.id === s.out.voice }, v.name));
    } catch {
      // desktop app not running: only the default
    }
  })();
  return wrap;
}

function toggle(checked: boolean, label: string, onchange: (v: boolean) => Promise<void>) {
  return h('label', { class: 'check' }, h('input', { type: 'checkbox', checked, onchange: (e: Event) => void onchange((e.target as HTMLInputElement).checked) }), label);
}

// ------------------------------------------------------------------ glossary

async function renderGlossary(body: HTMLElement) {
  const { glossary, settings } = await loadAll();
  const foreign = baseOf(settings.remote) === 'en' ? 'en' : 'es';
  let entries = glossary.map((e) => ({ ...e }));
  let timer: number | undefined;
  const persist = () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => void chrome.storage.local.set({ glossary: entries.filter((e) => e.zh || e.es || e.en) }), 300);
  };
  const split = (v: string) => v.split(/[;；,，]/).map((x) => x.trim()).filter(Boolean);
  const tbody = h('tbody');
  // The column headings are also each input's accessible name.
  const cols = ['中文', foreign === 'en' ? 'English' : 'Español', '中文常被识别成', foreign === 'en' ? '英语常被识别成' : '西语常被识别成', '备注'];
  const cell = (e: GlossaryEntry, key: 'zh' | 'es' | 'en' | 'note', col: number) =>
    h('td', {}, h('input', { type: 'text', 'aria-label': cols[col], value: (e[key] as string | undefined) ?? '', oninput: (ev: Event) => ((e[key] = (ev.target as HTMLInputElement).value), persist()) }));
  const aliasCell = (e: GlossaryEntry, key: 'aliasesZh' | 'aliasesEs' | 'aliasesEn', col: number) =>
    h('td', {}, h('input', { type: 'text', 'aria-label': cols[col], value: (e[key] ?? []).join('；'), placeholder: '用；分隔', oninput: (ev: Event) => ((e[key] = split((ev.target as HTMLInputElement).value)), persist()) }));
  const fill = () => {
    tbody.replaceChildren(
      ...entries.map((e) =>
        h('tr', {},
          cell(e, 'zh', 0),
          cell(e, foreign, 1),
          aliasCell(e, 'aliasesZh', 2),
          aliasCell(e, foreign === 'en' ? 'aliasesEn' : 'aliasesEs', 3),
          cell(e, 'note', 4),
          h('td', {}, h('button', { class: 'btn', 'aria-label': '删除', title: '删除', onclick: () => ((entries = entries.filter((x) => x !== e)), persist(), fill()) }, '✕')),
        ),
      ),
    );
  };
  fill();
  const file = h('input', {
    type: 'file',
    accept: '.csv,.txt,text/csv',
    style: 'display:none',
    onchange: async (ev: Event) => {
      const f = (ev.target as HTMLInputElement).files?.[0];
      if (!f) return;
      const res = parseGlossaryCsv(await f.text());
      const seen = new Set(entries.map((e) => `${e.zh}|${e.es}|${e.en ?? ''}`));
      for (const e of res.entries) if (!seen.has(`${e.zh}|${e.es}|${e.en ?? ''}`)) entries.push(e);
      persist();
      fill();
      msg.textContent = `导入 ${res.entries.length} 条${res.errors.length ? `，${res.errors.length} 行有问题` : ''}`;
    },
  });
  const msg = h('span', { class: 'muted small', role: 'status' });
  body.append(
    h('div', { class: 'row', style: 'margin-bottom:10px' },
      h('button', { class: 'btn primary', onclick: () => (entries.push({ id: newEntryId(), zh: '', es: '', en: '', aliasesZh: [], aliasesEs: [], aliasesEn: [], note: '', enabled: true }), fill()) }, '+ 添加术语'),
      h('button', { class: 'btn', onclick: () => file.click() }, '导入 CSV / Excel'),
      h('button', { class: 'btn', onclick: () => download('术语表.csv', glossaryToCsv(entries), 'text/csv') }, '导出 CSV'),
      file,
      msg,
    ),
    h('table', {},
      h('thead', {}, h('tr', {}, ...cols.map((c) => h('th', {}, c)), h('th', {}, h('span', { class: 'sr-only' }, '删除')))),
      tbody,
    ),
  );
}

// ------------------------------------------------------------------ meetings

async function renderMeetings(body: HTMLElement) {
  const r = await chrome.storage.local.get('meetings');
  const list = (r.meetings as SavedMeeting[] | undefined) ?? [];
  if (!list.length) {
    body.append(h('p', { class: 'muted' }, '还没有会议记录'));
    return;
  }
  const m = list.find((x) => x.meta.id === openMeeting);
  if (!m) {
    body.append(
      h('ul', { class: 'plain stack' },
        ...list.map((x) =>
          h('li', {},
            h('a', { class: 'card row between', style: 'color:inherit', href: `#meeting=${encodeURIComponent(x.meta.id)}` },
              h('div', {}, h('b', {}, x.meta.title), h('div', { class: 'muted small' }, `${new Date(x.meta.startedAt).toLocaleString('zh-CN')} · ${x.segments.length} 句${x.summary ? ' · 有纪要' : ''}`)),
              h('span', { class: 'muted', 'aria-hidden': 'true' }, '›'),
            ),
          ),
        ),
      ),
    );
    return;
  }
  const foreign = baseOf(m.meta.remoteLang) === 'en' ? 'en' : 'es';
  const base = m.meta.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'meeting';
  const status = h('span', { class: 'muted small', role: 'status' });
  let template: SummaryTemplate = 'general';
  const save = async (next: SavedMeeting) => {
    const cur = ((await chrome.storage.local.get('meetings')).meetings as SavedMeeting[] | undefined) ?? [];
    await chrome.storage.local.set({ meetings: cur.map((x) => (x.meta.id === next.meta.id ? next : x)) });
  };
  body.append(
    h('a', { href: '#meetings' }, '‹ 返回列表'),
    h('h2', { style: 'margin-top:12px' }, m.meta.title),
    h('div', { class: 'muted small', style: 'margin:4px 0 10px' }, `${new Date(m.meta.startedAt).toLocaleString('zh-CN')} · 中文 ⇄ ${lang(m.meta.remoteLang).nameZh}`),
    // Downloads first, then the minutes (template, generate, download), then delete.
    h('div', { class: 'row wrap', style: 'margin-bottom:12px' },
      h('button', { class: 'btn', onclick: () => download(`${base}.md`, toMarkdown(m.segments, m.meta, 'zh'), 'text/markdown') }, '下载双语记录'),
      h('button', { class: 'btn', onclick: () => download(`${base}.bilingual.srt`, toSrt(m.segments, 'bilingual')) }, '下载双语字幕'),
      h('span', { class: 'grow' }),
      h('span', { style: 'width:150px' }, select(template, Object.entries(TEMPLATE_NAMES), (v) => (template = v as SummaryTemplate), '纪要模板')),
      h('button', {
        class: 'btn primary',
        onclick: async (e: Event) => {
          const btn = e.target as HTMLButtonElement;
          btn.disabled = true;
          status.textContent = '生成中…';
          try {
            const data = await loadAll();
            const settings = toAppSettings(data.settings);
            const llm = makeLlm(settings, data.secrets, ctx(), true);
            if (!llm) throw new Error('生成纪要需要大模型：在“服务与语言”里选“自己组合”并配置大模型，或填写百炼 Key');
            const summary = await summarize(llm, m.segments, m.meta, data.glossary, template, {
              onProgress: (done, total) => (status.textContent = `生成中… ${done}/${total}`),
            });
            await save({ ...m, summary });
            void render();
          } catch (err) {
            status.textContent = err instanceof Error ? err.message : String(err);
            btn.disabled = false;
          }
        },
      }, m.summary ? '重新生成纪要' : '生成会议纪要'),
      m.summary ? h('button', { class: 'btn', onclick: () => download(`${base}.纪要.md`, summaryToMarkdown(m.summary as MeetingSummary, 'zh', m.meta), 'text/markdown') }, '下载中文纪要') : null,
      m.summary ? h('button', { class: 'btn', onclick: () => download(`${base}.minutes.${foreign}.md`, summaryToMarkdown(m.summary as MeetingSummary, foreign, m.meta), 'text/markdown') }, foreign === 'en' ? 'English minutes' : 'Acta en español') : null,
      h('button', {
        class: 'btn',
        onclick: async () => {
          if (!confirm('删除这场会议记录？')) return;
          const cur = ((await chrome.storage.local.get('meetings')).meetings as SavedMeeting[] | undefined) ?? [];
          await chrome.storage.local.set({ meetings: cur.filter((x) => x.meta.id !== m.meta.id) });
          openMeeting = null;
          if (location.hash === '#meetings') void render();
          else location.hash = '#meetings';
        },
      }, '删除'),
      status,
    ),
  );
  if (m.summary) {
    body.append(h('pre', { class: 'card', style: 'white-space:pre-wrap;font-family:inherit;font-size:14px;line-height:1.6' }, summaryToMarkdown(m.summary as MeetingSummary, 'zh', m.meta)));
  }
  body.append(
    h('div', { class: 'card' },
      ...m.segments.map((sg) =>
        h('div', { style: 'margin:8px 0' },
          h('div', { class: 'muted small' }, `${sg.speaker === 'me' ? '我方' : '对方'} · ${Math.floor(sg.start / 60)}:${String(Math.floor(sg.start % 60)).padStart(2, '0')}`),
          h('div', { lang: sg.srcLang }, sg.srcText),
          h('div', { lang: sg.dstLang, style: 'color:var(--blue)' }, sg.dstText ?? ''),
        ),
      ),
    ),
  );
}

chrome.storage.local.onChanged.addListener((changes) => {
  // Re-render when another page changes settings, but not while typing in the glossary.
  if (tab === 'settings' && (changes.settings || changes.secrets)) void render();
});
void render();
