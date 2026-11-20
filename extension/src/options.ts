import type { Secrets } from '@core/config/schema';
import { glossaryToCsv, parseGlossaryCsv } from '@core/glossary/csv';
import { newEntryId, type GlossaryEntry } from '@core/glossary/types';
import { baseOf, lang, REMOTE_LANGUAGES } from '@core/lang/languages';
import { azureVoicesFor } from '@core/providers/azure/common';
import { DASHSCOPE_VOICES } from '@core/providers/dashscope/tts';
import { LLM_PRESETS } from '@core/providers/openai-compatible';
import { makeLlm } from '@core/providers/registry';
import { summarize, summaryToMarkdown, TEMPLATE_NAMES, type MeetingSummary, type SummaryTemplate } from '@core/session/summary';
import { toMarkdown, toSrt } from '@core/session/transcript';
import { testDirection, testLlm } from '../../src/main/provider-test';
import { createProviders } from '@core/providers/registry';
import { consoleLogger, createBrowserContext } from './browser-context';
import { h, settingsProblem } from './dom';
import { loadAll, toAppSettings, withDefaults, type ExtSettings, type ProviderSet, type SavedMeeting } from './shared';

const app = document.getElementById('app')!;
let tab: 'settings' | 'glossary' | 'meetings' = 'settings';
let openMeeting: string | null = null;
function readHash() {
  const m = /meeting=([^&]+)/.exec(location.hash);
  if (m) {
    tab = 'meetings';
    openMeeting = decodeURIComponent(m[1]!);
  } else if (location.hash === '#glossary') tab = 'glossary';
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
      h('h1', {}, '会议同传 · 设置'),
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

const SETS: { id: ProviderSet; name: string; desc: string }[] = [
  { id: 'dashscope', name: '阿里云百炼（推荐）', desc: '一个 Key 搞定识别、翻译、发音，国内直连，准确度最高。新用户有免费额度，之后约 2–4 元/小时。' },
  { id: 'azure', name: '微软 Azure', desc: '需要 Azure 语音和 Azure 翻译两个 Key（都有免费层）。免费层同一时间只能识别一路，双向同传请用标准层。' },
  { id: 'custom', name: '自己组合', desc: '每个方向分别选识别、翻译、发音服务，例如翻译换成免费的智谱 GLM 或 DeepL。' },
  { id: 'demo', name: '演示', desc: '不需要 Key，只用来看看效果（说什么都会出固定的演示句子）。' },
];

function secretInput(secrets: Secrets, name: keyof Secrets, label: string, hint?: string) {
  const input = h('input', { type: 'password', placeholder: secrets[name] ? '已保存（重新输入可替换）' : '粘贴 Key', autocomplete: 'off' });
  const save = h('button', {
    class: 'btn',
    onclick: async () => {
      const { secrets: cur } = await loadAll();
      const v = input.value.trim();
      await chrome.storage.local.set({ secrets: { ...cur, [name]: v || undefined } });
      void render();
    },
  }, '保存');
  return h('label', { class: 'field' }, h('span', {}, label, secrets[name] ? ' ✅' : ''), h('div', { class: 'row' }, input, save), hint ? h('div', { class: 'small', style: 'margin-top:4px' }, hint) : null);
}

function select(value: string, options: [string, string][], onchange: (v: string) => void) {
  return h('select', { onchange: (e: Event) => onchange((e.target as HTMLSelectElement).value) }, ...options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
}

function voiceOptions(tts: string, code: string): [string, string][] {
  const list = tts === 'dashscope' ? DASHSCOPE_VOICES.map((v) => [v.id, v.name] as [string, string]) : tts === 'azure' ? azureVoicesFor(code).map((v) => [v.id, v.name] as [string, string]) : [];
  return [['', '默认'], ...list];
}

async function renderSettings(body: HTMLElement) {
  const { settings: s, secrets } = await loadAll();
  const problem = settingsProblem(await loadAll());
  const set = async (patch: Partial<ExtSettings>) => {
    await saveSettings(patch);
    void render();
  };

  body.append(
    h('div', { class: 'card stack' },
      h('h2', { style: 'margin-top:0' }, '① 对方说什么语言'),
      select(s.remote, REMOTE_LANGUAGES.map((c) => [c, lang(c).nameZh]), (v) => void set({ remote: v, out: { ...s.out, voice: '' } })),
      h('div', { class: 'muted small' }, '我方固定为中文。对方的口音选对了，识别和发音更准。'),
    ),
  );

  body.append(
    h('div', { class: 'card stack', style: 'margin-top:14px' },
      h('h2', { style: 'margin-top:0' }, '② 翻译服务'),
      ...SETS.map((x) =>
        h('label', { class: 'row', style: 'align-items:flex-start;cursor:pointer' },
          h('input', { type: 'radio', name: 'set', checked: s.providers === x.id, onchange: () => void set({ providers: x.id }) }),
          h('div', {}, h('b', {}, x.name), h('div', { class: 'muted small' }, x.desc)),
        ),
      ),
    ),
  );

  const keys = h('div', { class: 'card stack', style: 'margin-top:14px' }, h('h2', { style: 'margin-top:0' }, '③ 填写 Key'));
  const uses = (p: string) => [s.out.asr, s.out.mt, s.out.tts, s.in.asr, s.in.mt, s.in.tts].includes(p);
  const usesLlm = uses('llm');
  if (uses('dashscope') || uses('qwen-mt') || (usesLlm && s.llm.preset === 'qwen')) {
    keys.append(
      secretInput(secrets, 'dashscope', '阿里云百炼 API Key', '登录 bailian.console.aliyun.com › API Key 创建（sk- 开头）。'),
      h('label', { class: 'field' }, h('span', {}, '百炼地域'), select(s.dashscopeRegion, [['cn', '中国（北京）'], ['intl', '国际（新加坡）']], (v) => void set({ dashscopeRegion: v as 'cn' | 'intl' }))),
    );
  }
  if (uses('azure')) {
    keys.append(
      secretInput(secrets, 'azure', 'Azure 语音服务 Key', '在 Azure 门户创建“语音服务”。'),
      h('label', { class: 'field' }, h('span', {}, 'Azure 语音区域'), h('input', { type: 'text', value: s.azureRegion, onchange: (e: Event) => void set({ azureRegion: (e.target as HTMLInputElement).value.trim() }) })),
    );
  }
  if (uses('azure-translator')) {
    keys.append(
      secretInput(secrets, 'azureTranslator', 'Azure 翻译 Key', '在 Azure 门户创建“翻译”资源，F0 每月 200 万字符免费。'),
      h('label', { class: 'field' }, h('span', {}, 'Azure 翻译区域（全局资源留空）'), h('input', { type: 'text', value: s.azureTranslatorRegion, onchange: (e: Event) => void set({ azureTranslatorRegion: (e.target as HTMLInputElement).value.trim() }) })),
    );
  }
  if (usesLlm) {
    keys.append(
      h('label', { class: 'field' }, h('span', {}, '翻译大模型'), select(s.llm.preset, LLM_PRESETS.map((p) => [p.id, p.name]), (v) => void set({ llm: { ...s.llm, preset: v, baseUrl: '', model: '' } }))),
      secretInput(secrets, 'llm', '大模型 API Key', s.llm.preset === 'zhipu-free' ? '在 bigmodel.cn 注册，“API Keys”里创建；GLM-4.7-Flash 免费。' : undefined),
    );
    if (s.llm.preset === 'custom') {
      keys.append(
        h('label', { class: 'field' }, h('span', {}, '接口地址（OpenAI 兼容）'), h('input', { type: 'text', value: s.llm.baseUrl, onchange: (e: Event) => void set({ llm: { ...s.llm, baseUrl: (e.target as HTMLInputElement).value.trim() } }) })),
        h('label', { class: 'field' }, h('span', {}, '模型名'), h('input', { type: 'text', value: s.llm.model, onchange: (e: Event) => void set({ llm: { ...s.llm, model: (e.target as HTMLInputElement).value.trim() } }) })),
      );
    }
  }
  if (uses('deepl')) keys.append(secretInput(secrets, 'deepl', 'DeepL API Key'));
  if (keys.childElementCount === 1) keys.append(h('div', { class: 'muted' }, '当前方案不需要 Key。'));
  if (problem) keys.append(h('div', { class: 'callout warn' }, problem));
  body.append(keys);

  if (s.providers === 'custom') {
    const dirCard = h('div', { class: 'card stack', style: 'margin-top:14px' }, h('h2', { style: 'margin-top:0' }, '每个方向的服务'));
    for (const d of ['out', 'in'] as const) {
      const c = s[d];
      const upd = (patch: Partial<ExtSettings['out']>) => void set({ [d]: { ...c, ...patch } } as Partial<ExtSettings>);
      dirCard.append(
        h('b', {}, d === 'out' ? '我说中文 → 对方听' : '对方说话 → 我看中文'),
        h('div', { class: 'grid2' },
          h('label', { class: 'field' }, h('span', {}, '语音识别'), select(c.asr, [['dashscope', '阿里云百炼'], ['azure', 'Azure'], ['demo', '演示']], (v) => upd({ asr: v }))),
          h('label', { class: 'field' }, h('span', {}, '翻译'), select(c.mt, [['qwen-mt', '百炼 翻译模型'], ['llm', '大模型（可选免费的智谱）'], ['deepl', 'DeepL'], ['azure-translator', 'Azure 翻译'], ['demo', '演示']], (v) => upd({ mt: v }))),
          h('label', { class: 'field' }, h('span', {}, '发音'), select(c.tts, [['dashscope', '阿里云百炼'], ['azure', 'Azure'], ['none', '不发音'], ['demo', '演示']], (v) => upd({ tts: v }))),
        ),
      );
    }
    body.append(dirCard);
  }

  body.append(
    h('div', { class: 'card stack', style: 'margin-top:14px' },
      h('h2', { style: 'margin-top:0' }, '④ 声音和字幕'),
      s.out.tts !== 'none' && s.out.tts !== 'demo'
        ? h('label', { class: 'field' }, h('span', {}, `对方听到的声音（${lang(s.remote).nameZh}）`), select(s.out.voice, voiceOptions(s.out.tts, s.remote), (v) => void set({ out: { ...s.out, voice: v } })))
        : null,
      toggle(s.playOriginal, '听对方的原声', (v) => set({ playOriginal: v })),
      toggle(s.speakIn, '同时用中文读出对方的话（默认只看字幕）', (v) => set({ speakIn: v })),
      toggle(s.showMine, '字幕里也显示我说的话和译文（方便确认翻得对不对）', (v) => set({ showMine: v })),
      toggle(s.pinyinFuzzy, '术语近音纠错（把识别错的同音词改成术语表里的写法）', (v) => set({ pinyinFuzzy: v })),
      h('label', { class: 'field' }, h('span', {}, `字幕字号：${s.subtitleSize}`), h('input', { type: 'range', min: 14, max: 40, value: s.subtitleSize, onchange: (e: Event) => void set({ subtitleSize: Number((e.target as HTMLInputElement).value) }) })),
    ),
  );

  const out = h('div', { class: 'stack' });
  body.append(
    h('div', { class: 'card stack', style: 'margin-top:14px' },
      h('h2', { style: 'margin-top:0' }, '⑤ 测试'),
      h('div', { class: 'muted small' }, '用真实服务测一遍：合成一句话 → 识别 → 翻译 → 发音。'),
      h('button', {
        class: 'btn primary',
        disabled: !!problem,
        onclick: async (e: Event) => {
          const btn = e.target as HTMLButtonElement;
          btn.disabled = true;
          out.replaceChildren(h('div', { class: 'muted' }, '测试中…'));
          try {
            const data = await loadAll();
            const settings = toAppSettings(data.settings);
            const p = createProviders(settings, data.secrets, ctx(), () => data.glossary);
            const steps = [
              ...(await testDirection(p, 'out', 'zh-CN', settings.languages.remote)),
              ...(await testDirection(p, 'in', settings.languages.remote, 'zh-CN')),
              ...(data.settings.out.mt === 'llm' || data.settings.in.mt === 'llm' ? await testLlm(makeLlm(settings, data.secrets, ctx())) : []),
            ];
            out.replaceChildren(...steps.map((st) => h('div', {}, `${st.ok ? '✅' : '❌'} ${st.name}（${st.ms} ms）`, h('div', { class: 'muted small' }, st.detail))));
          } catch (err) {
            out.replaceChildren(h('div', { class: 'callout err' }, err instanceof Error ? err.message : String(err)));
          } finally {
            btn.disabled = false;
          }
        },
      }, '开始测试'),
      out,
    ),
    h('div', { class: 'card stack', style: 'margin-top:14px' },
      h('h2', { style: 'margin-top:0' }, '怎么用'),
      h('ol', { class: 'muted', style: 'line-height:1.8;margin:0;padding-left:20px' },
        h('li', {}, '在 Chrome 里打开网页版会议（Teams、Google Meet、飞书、腾讯会议、Zoom），入会。'),
        h('li', {}, '点浏览器右上角的插件图标 → “开始同传”。'),
        h('li', {}, '你说中文，对方在会议里听到翻译后的声音（你的原声不会传过去）；对方说话时，页面下方出现中文字幕。'),
        h('li', {}, '建议戴耳机。结束后可在“会议记录”里下载双语记录、生成会议纪要。'),
      ),
      h('div', { class: 'muted small' }, '如果插件装好前就已经进了会议，请刷新会议页面重新入会。'),
    ),
  );
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
      '公司名、产品名、人名和行业词的固定译法。识别时优先听成这些词，识别错的“别名”会自动改正，翻译时强制使用你填的译法。例：中文“西瓜尔纳一号”，中文别名“西瓜那一号；西瓜尔那一号”，外文填双方约定的叫法。',
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
    h('p', { class: 'muted small' }, '表格显示当前对方语言那一列；导入的 CSV 可以同时含中文、Español、English 三列（桌面版导出的术语表可以直接导入）。'),
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
