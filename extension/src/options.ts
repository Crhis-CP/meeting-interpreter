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
import { buildProviders, usesDesktop } from './engine-providers';
import { DESKTOP_BRIDGE_PORT, pingDesktop } from '@core/bridge/desktop';
import { h, settingsProblem } from './dom';
import { DESKTOP_DOWNLOAD, KEY_LINKS, loadAll, missingKey, toAppSettings, withDefaults, type ExtSettings, type ProviderSet, type SavedMeeting } from './shared';

const app = document.getElementById('app')!;
let tab: 'settings' | 'glossary' | 'meetings' = 'settings';
let openMeeting: string | null = null;
function readHash() {
  const m = /meeting=([^&]+)/.exec(location.hash);
  if (m) {
    tab = 'meetings';
    openMeeting = decodeURIComponent(m[1]!);
  } else if (location.hash === '#glossary') tab = 'glossary';
  else if (location.hash === '#test') tab = 'settings';
  else if (location.hash === '#meetings') tab = 'meetings';
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
  app.replaceChildren(
    h(
      'div',
      { class: 'row between', style: 'margin-bottom:8px' },
      h('div', { class: 'row' }, h('img', { src: 'icons/icon-48.png', width: 32, height: 32, alt: '' }), h('h1', {}, '会议同传')),
      h('span', { class: 'muted small' }, `版本 ${chrome.runtime.getManifest().version}`),
    ),
    h(
      'div',
      { class: 'seg', style: 'max-width:420px;margin:12px 0 20px' },
      ...(
        [
          ['settings', '服务与语言'],
          ['glossary', '术语表'],
          ['meetings', '会议记录'],
        ] as const
      ).map(([k, label]) => h('button', { class: tab === k ? 'on' : '', onclick: () => ((tab = k), void render()) }, label)),
    ),
  );
  const body = h('div');
  app.append(body);
  if (tab === 'settings') await renderSettings(body);
  else if (tab === 'glossary') await renderGlossary(body);
  else await renderMeetings(body);
}

// ------------------------------------------------------------------ settings

const MORE_SETS: { id: ProviderSet; name: string }[] = [
  { id: 'azure', name: '微软 Azure（语音 + 翻译两个 Key）' },
  { id: 'custom', name: '自己组合（每个方向分别选服务）' },
  { id: 'demo', name: '演示（不需要 Key，只看效果）' },
];

function secretInput(secrets: Secrets, name: keyof Secrets, label: string, link?: string) {
  const input = h('input', { type: 'password', placeholder: secrets[name] ? '已保存 ✓（重新粘贴可替换）' : '粘贴 Key', autocomplete: 'off' });
  const save = h('button', {
    class: 'btn',
    onclick: async () => {
      const { secrets: cur } = await loadAll();
      await chrome.storage.local.set({ secrets: { ...cur, [name]: input.value.trim() || undefined } });
      void render();
    },
  }, '保存');
  return h('div', { class: 'stack' },
    h('div', { class: 'row between' }, h('b', {}, label, secrets[name] ? ' ✅' : ''), link ? h('a', { href: link, target: '_blank', class: 'btn sm primary' }, '去获取 ↗') : ''),
    h('div', { class: 'row' }, input, save),
  );
}

function select(value: string, options: [string, string][], onchange: (v: string) => void) {
  return h('select', { onchange: (e: Event) => onchange((e.target as HTMLSelectElement).value) }, ...options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
}

function voiceOptions(tts: string, code: string): [string, string][] {
  const list = tts === 'dashscope' ? DASHSCOPE_VOICES.map((v) => [v.id, v.name] as [string, string]) : tts === 'azure' ? azureVoicesFor(code).map((v) => [v.id, v.name] as [string, string]) : [];
  return [['', '默认'], ...list];
}

const field = (label: string, control: Node) => h('label', { class: 'field' }, h('span', {}, label), control);

async function renderSettings(body: HTMLElement) {
  const data = await loadAll();
  const { settings: s, secrets } = data;
  const problem = settingsProblem(data);
  const set = async (patch: Partial<ExtSettings>) => {
    await saveSettings(patch);
    void render();
  };
  const uses = (p: string) => [s.out.asr, s.out.mt, s.out.tts, s.in.asr, s.in.mt, s.in.tts].includes(p);

  // ---- the essentials: language, tier, key, test
  const main = h('div', { class: 'card stack' });
  main.append(
    field('对方说', select(baseOf(s.remote), REMOTE_CHOICES.map((c) => [c.base, c.name]), (v) => void set({ remote: withRemoteBase(s.remote, v as 'es' | 'en'), out: { ...s.out, voice: '' } }))),
    h('div', { class: 'label', style: 'margin-top:14px' }, '方案'),
    h('div', { class: 'seg', style: 'max-width:420px' },
      h('button', { class: s.providers === 'free' ? 'on' : '', onclick: () => void set({ providers: 'free' }) }, '免费'),
      h('button', { class: s.providers === 'dashscope' ? 'on' : '', onclick: () => void set({ providers: 'dashscope' }) }, '高级 · 最准'),
      ...(s.providers !== 'free' && s.providers !== 'dashscope' ? [h('button', { class: 'on' }, MORE_SETS.find((x) => x.id === s.providers)?.name.split('（')[0] ?? '其他')] : []),
    ),
    h('div', { class: 'muted small' },
      s.providers === 'free' ? '免费：电脑上打开桌面客户端 + 一个免费的智谱 Key。'
        : s.providers === 'dashscope' ? '高级：一个阿里云百炼 Key。新用户有免费额度，之后约 2–4 元/小时。'
          : ''),
  );
  if (s.providers === 'free' || uses('llm')) {
    if (s.llm.preset === 'zhipu-free' || s.providers === 'free') main.append(secretInput(secrets, 'llm', s.llm.preset === 'zhipu-free' ? KEY_LINKS.llm.label : '大模型 Key', s.llm.preset === 'zhipu-free' ? KEY_LINKS.llm.url : undefined));
  }
  if (uses('dashscope') || uses('qwen-mt') || (uses('llm') && s.llm.preset === 'qwen')) main.append(secretInput(secrets, 'dashscope', KEY_LINKS.dashscope.label, KEY_LINKS.dashscope.url));
  if (uses('azure')) main.append(secretInput(secrets, 'azure', 'Azure 语音 Key', 'https://portal.azure.com/#create/Microsoft.CognitiveServicesSpeechServices'));
  if (uses('azure-translator')) main.append(secretInput(secrets, 'azureTranslator', 'Azure 翻译 Key', 'https://portal.azure.com/#create/Microsoft.CognitiveServicesTextTranslation'));
  if (uses('deepl')) main.append(secretInput(secrets, 'deepl', 'DeepL Key', 'https://www.deepl.com/pro-api'));
  if (usesDesktop(s)) {
    const st = h('div', { class: 'muted small' }, '正在检查桌面客户端…');
    main.append(st);
    void pingDesktop(ctx()).then((p) => {
      if (p) st.replaceChildren(`✅ 桌面客户端已连接（${p.version}）`);
      else {
        st.className = 'callout warn';
        st.replaceChildren('没检测到桌面客户端：请在电脑上打开它 ', h('a', { href: DESKTOP_DOWNLOAD, target: '_blank' }, '下载 ↗'));
      }
    });
  }
  if (problem && !missingKey(s, secrets)) main.append(h('div', { class: 'callout warn' }, problem));

  const results = h('div', { class: 'stack' });
  main.append(
    h('button', {
      id: 'test',
      class: 'big',
      style: 'margin-top:8px',
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
            h('div', { class: `callout ${ok ? 'info' : 'err'}` }, ok ? '✅ 一切正常，可以开会了' : '有步骤没通过，看下面的原因'),
            ...steps.map((x) => h('div', { class: 'small' }, `${x.ok ? '✅' : '❌'} ${x.name}`, h('span', { class: 'muted' }, ` ${x.detail}`))),
          );
        } catch (err) {
          results.append(h('div', { class: 'callout err' }, err instanceof Error ? err.message : String(err)));
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

  // ---- everything else, folded away
  const more = h('details', { class: 'card', style: 'margin-top:14px' }, h('summary', {}, '更多设置'));
  const moreBody = h('div', { class: 'stack', style: 'margin-top:10px' });
  more.append(moreBody);
  moreBody.append(
    field('口音（一般不用改）', select(s.remote, accentsOf(baseOf(s.remote)).map((a) => [a.code, a.name]), (v) => void set({ remote: v, out: { ...s.out, voice: '' } }))),
    h('div', { class: 'label' }, '其他方案'),
    ...MORE_SETS.map((x) =>
      h('label', { class: 'row', style: 'cursor:pointer;font-size:14px' },
        h('input', { type: 'radio', name: 'more', checked: s.providers === x.id, onchange: () => void set({ providers: x.id }) }), x.name),
    ),
  );
  if (uses('llm')) {
    moreBody.append(field('翻译用的大模型', select(s.llm.preset, LLM_PRESETS.map((p) => [p.id, p.name]), (v) => void set({ llm: { ...s.llm, preset: v, baseUrl: '', model: '' } }))));
    if (s.llm.preset !== 'zhipu-free' && s.providers !== 'free') moreBody.append(secretInput(secrets, 'llm', '大模型 Key'));
    if (s.llm.preset === 'custom') {
      moreBody.append(
        field('接口地址（OpenAI 兼容）', h('input', { type: 'text', value: s.llm.baseUrl, onchange: (e: Event) => void set({ llm: { ...s.llm, baseUrl: (e.target as HTMLInputElement).value.trim() } }) })),
        field('模型名', h('input', { type: 'text', value: s.llm.model, onchange: (e: Event) => void set({ llm: { ...s.llm, model: (e.target as HTMLInputElement).value.trim() } }) })),
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
  if (uses('dashscope') || uses('qwen-mt')) moreBody.append(field('百炼地域', select(s.dashscopeRegion, [['cn', '中国（北京）'], ['intl', '国际（新加坡）']], (v) => void set({ dashscopeRegion: v as 'cn' | 'intl' }))));
  if (uses('azure')) moreBody.append(field('Azure 语音区域', h('input', { type: 'text', value: s.azureRegion, onchange: (e: Event) => void set({ azureRegion: (e.target as HTMLInputElement).value.trim() }) })));
  if (uses('azure-translator')) moreBody.append(field('Azure 翻译区域（全局资源留空）', h('input', { type: 'text', value: s.azureTranslatorRegion, onchange: (e: Event) => void set({ azureTranslatorRegion: (e.target as HTMLInputElement).value.trim() }) })));
  if (s.providers === 'custom') {
    for (const d of ['out', 'in'] as const) {
      const c = s[d];
      const upd = (patch: Partial<ExtSettings['out']>) => void set({ [d]: { ...c, ...patch } } as Partial<ExtSettings>);
      moreBody.append(
        h('b', {}, d === 'out' ? '我说话' : '对方说话'),
        h('div', { class: 'grid2' },
          field('识别', select(c.asr, [['local', '本机（桌面客户端，免费）'], ['dashscope', '阿里云百炼'], ['azure', 'Azure'], ['demo', '演示']], (v) => upd({ asr: v }))),
          field('翻译', select(c.mt, [['llm', '大模型'], ['qwen-mt', '百炼翻译'], ['deepl', 'DeepL'], ['azure-translator', 'Azure 翻译'], ['demo', '演示']], (v) => upd({ mt: v }))),
          field('发音', select(c.tts, [['system', '电脑自带声音（免费）'], ['dashscope', '阿里云百炼'], ['azure', 'Azure'], ['none', '不发音'], ['demo', '演示']], (v) => upd({ tts: v }))),
        ),
      );
    }
  }
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
  if (location.hash === '#test') document.getElementById('test')?.scrollIntoView();
}

/** “用我的声音”: record 16 s, clone it with 百炼, and let the other side hear my own voice. */
function myVoiceCard(s: ExtSettings, set: (p: Partial<ExtSettings>) => Promise<void>) {
  const status = h('span', { class: 'muted small' });
  const consent = h('input', { type: 'checkbox' });
  const recordBtn = h('button', {
    class: 'btn primary',
    onclick: async () => {
      if (!consent.checked) return void (status.textContent = '请先勾选同意');
      recordBtn.disabled = true;
      try {
        const wav = await recordVoiceSample(SAMPLE_SECONDS, (left) => (status.textContent = left ? `正在录音，请朗读上面的文字… ${left} 秒` : '录好了'));
        status.textContent = '正在生成你的音色（约半分钟）…';
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
  return h('div', { class: 'card stack', style: 'margin-top:14px' },
    h('div', { class: 'row between' }, h('b', {}, '用我的声音'), s.myVoiceId ? toggle(s.useMyVoice, '对方听到我的声音', (v) => set({ useMyVoice: v })) : ''),
    h('div', { class: 'muted small' }, '对方听到的翻译用你自己的音色。生成音色免费，合成按百炼正常价格计费。'),
    h('div', { class: 'callout info', style: 'font-size:15px;line-height:1.7' }, SAMPLE_SCRIPT),
    h('label', { class: 'row small', style: 'cursor:pointer' }, consent, '这是我本人的声音，我同意用它合成我的翻译语音'),
    h('div', { class: 'row' }, recordBtn, status),
  );
}

/** Voices installed on the computer, listed by the desktop app. */
function systemVoiceSelect(s: ExtSettings, set: (p: Partial<ExtSettings>) => Promise<void>) {
  const wrap = h('label', { class: 'field' }, h('span', {}, '对方听到的声音'));
  const sel = select(s.out.voice, [['', '默认']], (v) => void set({ out: { ...s.out, voice: v } }));
  wrap.append(sel);
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
  return h('label', { class: 'row', style: 'font-size:14px;cursor:pointer' }, h('input', { type: 'checkbox', checked, onchange: (e: Event) => void onchange((e.target as HTMLInputElement).checked) }), label);
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
  const cell = (e: GlossaryEntry, key: 'zh' | 'es' | 'en' | 'note', ph = '') =>
    h('td', {}, h('input', { type: 'text', value: (e[key] as string | undefined) ?? '', placeholder: ph, oninput: (ev: Event) => ((e[key] = (ev.target as HTMLInputElement).value), persist()) }));
  const aliasCell = (e: GlossaryEntry, key: 'aliasesZh' | 'aliasesEs' | 'aliasesEn') =>
    h('td', {}, h('input', { type: 'text', value: (e[key] ?? []).join('；'), placeholder: '用；分隔', oninput: (ev: Event) => ((e[key] = split((ev.target as HTMLInputElement).value)), persist()) }));
  const fill = () => {
    tbody.replaceChildren(
      ...entries.map((e) =>
        h('tr', {},
          cell(e, 'zh', '中文'),
          cell(e, foreign, foreign === 'en' ? 'English' : 'Español'),
          aliasCell(e, 'aliasesZh'),
          aliasCell(e, foreign === 'en' ? 'aliasesEn' : 'aliasesEs'),
          cell(e, 'note'),
          h('td', {}, h('button', { class: 'btn', title: '删除', onclick: () => ((entries = entries.filter((x) => x !== e)), persist(), fill()) }, '✕')),
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
  const msg = h('span', { class: 'muted small' });
  body.append(
    h('p', { class: 'muted', style: 'line-height:1.6' },
      '公司名、产品名、人名的固定译法。“别名”填常被听错的写法，会自动改正。',
    ),
    h('div', { class: 'row', style: 'margin-bottom:10px' },
      h('button', { class: 'btn primary', onclick: () => (entries.push({ id: newEntryId(), zh: '', es: '', en: '', aliasesZh: [], aliasesEs: [], aliasesEn: [], note: '', enabled: true }), fill()) }, '+ 添加术语'),
      h('button', { class: 'btn', onclick: () => file.click() }, '导入 CSV / Excel'),
      h('button', { class: 'btn', onclick: () => download('术语表.csv', glossaryToCsv(entries), 'text/csv') }, '导出 CSV'),
      file,
      msg,
    ),
    h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, '中文'), h('th', {}, foreign === 'en' ? 'English' : 'Español'), h('th', {}, '中文别名（常被识别成）'), h('th', {}, foreign === 'en' ? '英语别名' : '西语别名'), h('th', {}, '备注'), h('th', {}))),
      tbody,
    ),
  );
}

// ------------------------------------------------------------------ meetings

async function renderMeetings(body: HTMLElement) {
  const r = await chrome.storage.local.get('meetings');
  const list = (r.meetings as SavedMeeting[] | undefined) ?? [];
  if (!list.length) {
    body.append(h('div', { class: 'muted' }, '还没有会议记录。用插件开过一次同传后，这里会出现双语记录。'));
    return;
  }
  const m = list.find((x) => x.meta.id === openMeeting);
  if (!m) {
    body.append(
      ...list.map((x) =>
        h('div', { class: 'card row between', style: 'margin-bottom:8px;cursor:pointer', onclick: () => ((openMeeting = x.meta.id), void render()) },
          h('div', {}, h('b', {}, x.meta.title), h('div', { class: 'muted small' }, `${new Date(x.meta.startedAt).toLocaleString('zh-CN')} · ${x.segments.length} 句${x.summary ? ' · 有纪要' : ''}`)),
          h('span', { class: 'muted' }, '›'),
        ),
      ),
    );
    return;
  }
  const foreign = baseOf(m.meta.remoteLang) === 'en' ? 'en' : 'es';
  const base = m.meta.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'meeting';
  const status = h('span', { class: 'muted small' });
  let template: SummaryTemplate = 'general';
  const save = async (next: SavedMeeting) => {
    const cur = ((await chrome.storage.local.get('meetings')).meetings as SavedMeeting[] | undefined) ?? [];
    await chrome.storage.local.set({ meetings: cur.map((x) => (x.meta.id === next.meta.id ? next : x)) });
  };
  body.append(
    h('a', { onclick: () => ((openMeeting = null), void render()) }, '‹ 返回列表'),
    h('h2', {}, m.meta.title),
    h('div', { class: 'muted small', style: 'margin-bottom:10px' }, `${new Date(m.meta.startedAt).toLocaleString('zh-CN')} · 中文 ⇄ ${lang(m.meta.remoteLang).nameZh}`),
    h('div', { class: 'row', style: 'flex-wrap:wrap;margin-bottom:12px' },
      h('button', { class: 'btn', onclick: () => download(`${base}.md`, toMarkdown(m.segments, m.meta, 'zh'), 'text/markdown') }, '下载双语记录'),
      h('button', { class: 'btn', onclick: () => download(`${base}.bilingual.srt`, toSrt(m.segments, 'bilingual')) }, '下载双语字幕'),
      select(template, Object.entries(TEMPLATE_NAMES), (v) => (template = v as SummaryTemplate)),
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
          void render();
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
          h('div', {}, sg.srcText),
          h('div', { style: 'color:#1d4ed8' }, sg.dstText ?? ''),
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
