import { pingDesktop } from '@core/bridge/desktop';
import { consoleLogger, createBrowserContext } from './browser-context';
import { h, settingsProblem } from './dom';
import { usesDesktop } from './engine-providers';
import { IDLE_STATE, loadAll, MEETING_SITES, withDefaults, type SessionState, type ToBackground } from './shared';

const app = document.getElementById('app')!;

const send = async (m: ToBackground): Promise<SessionState> => ((await chrome.runtime.sendMessage(m)) as SessionState | undefined) ?? IDLE_STATE;
const openOptions = (hash = '') => void chrome.tabs.create({ url: chrome.runtime.getURL(`options.html${hash}`) });

/** True when the URL matches one of the meeting sites the extension hooks. */
function isMeetingSite(url: string | undefined): boolean {
  if (!url) return false;
  return MEETING_SITES.some((p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(url));
}

const STATE_TEXT: Record<string, string> = {
  idle: '未开始',
  connecting: '连接中…',
  listening: '正在听',
  reconnecting: '重新连接中…',
  error: '出错',
  stopped: '已停止',
};
const dotClass = (s: string) => (s === 'listening' ? 'ok' : s === 'error' ? 'err' : s === 'idle' || s === 'stopped' ? '' : 'busy');

let busy = false;
let timer: number | undefined;

async function render() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const data = await loadAll();
  const st = await send({ type: 'state' });
  const s = data.settings;
  const running = st.status === 'running' || st.status === 'starting' || st.status === 'stopping';
  const here = running && st.tabId === tab?.id;
  clearInterval(timer);
  app.replaceChildren();

  app.append(
    h('div', { class: 'row between', style: 'margin-bottom:14px' }, h('h1', {}, '会议同传'), h('a', { class: 'small', onclick: () => openOptions() }, '设置')),
  );

  if (!running) {
    const isEn = s.remote.startsWith('en');
    const setRemote = async (code: string) => {
      await chrome.storage.local.set({ settings: withDefaults({ ...s, remote: code }) });
      void render();
    };
    app.append(
      h('div', { class: 'muted', style: 'margin-bottom:6px' }, '对方说'),
      h(
        'div',
        { class: 'seg', style: 'margin-bottom:14px' },
        h('button', { class: isEn ? '' : 'on', onclick: () => !isEn || void setRemote('es-MX') }, '西班牙语'),
        h('button', { class: isEn ? 'on' : '', onclick: () => isEn || void setRemote('en-US') }, 'English'),
      ),
    );
    const setProviders = async (providers: 'free' | 'dashscope') => {
      await chrome.storage.local.set({ settings: withDefaults({ ...s, providers }) });
      void render();
    };
    const other = s.providers !== 'free' && s.providers !== 'dashscope';
    app.append(
      h('div', { class: 'muted', style: 'margin-bottom:6px' }, '方案'),
      h(
        'div',
        { class: 'seg', style: 'margin-bottom:6px' },
        h('button', { class: s.providers === 'free' ? 'on' : '', onclick: () => void setProviders('free') }, '免费版'),
        h('button', { class: s.providers === 'dashscope' ? 'on' : '', onclick: () => void setProviders('dashscope') }, '高级版'),
        other ? h('button', { class: 'on', onclick: () => openOptions() }, { azure: 'Azure', custom: '自定义', demo: '演示' }[s.providers as 'azure'] ?? '自定义') : null,
      ),
      h(
        'div',
        { class: 'muted small', style: 'margin-bottom:14px;line-height:1.5' },
        s.providers === 'free' ? '免费：需要电脑上同时打开桌面客户端，翻译用免费的智谱 GLM。' : s.providers === 'dashscope' ? '准确度最高、声音最自然：阿里云百炼，一个 Key。' : '',
      ),
    );
    if (usesDesktop(s)) {
      const warn = h('div');
      app.append(warn);
      void pingDesktop(createBrowserContext(consoleLogger('popup'), async () => undefined)).then((ok) => {
        if (!ok) {
          warn.replaceWith(
            h('div', { class: 'callout warn', style: 'margin-bottom:12px' }, '免费版需要先打开电脑上的“会议同传助手”桌面客户端。', ' ', h('a', { href: 'https://github.com/Crhis-CP/meeting-interpreter/releases/latest', target: '_blank' }, '下载')),
          );
        }
      });
    }
    const problem = settingsProblem(data);
    if (problem) {
      app.append(
        h('div', { class: 'callout warn', style: 'margin-bottom:12px' }, problem, ' ', h('a', { onclick: () => openOptions() }, '去填写')),
      );
    }
    if (!isMeetingSite(tab?.url)) {
      app.append(
        h('div', { class: 'callout info', style: 'margin-bottom:12px' }, '请先在浏览器里打开会议（Teams、Google Meet、飞书、腾讯会议、Zoom 网页版），再点开始。'),
      );
    }
    if (st.error) app.append(h('div', { class: 'callout err', style: 'margin-bottom:12px' }, st.error));
    app.append(
      h(
        'button',
        {
          class: 'big',
          disabled: busy || !!problem || !tab?.id,
          onclick: async () => {
            busy = true;
            void render();
            await send({ type: 'start', tabId: tab!.id! });
            busy = false;
            void render();
          },
        },
        busy ? '正在启动…' : '开始同传',
      ),
      h(
        'p',
        { class: 'muted small', style: 'line-height:1.6' },
        `你说中文，对方在会议里听到${isEn ? '英语' : '西班牙语'}；对方说话时，屏幕上出现中文字幕。`,
      ),
    );
    if (st.lastMeetingId) app.append(h('a', { class: 'small', onclick: () => openOptions(`#meeting=${st.lastMeetingId}`) }, '查看上一场会议记录 →'));
    return;
  }

  // Running.
  const clock = h('span', { class: 'muted' });
  const tick = () => {
    const sec = st.startedAt ? Math.floor((Date.now() - st.startedAt) / 1000) : 0;
    clock.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  };
  tick();
  timer = window.setInterval(tick, 1000);
  app.append(
    h('div', { class: 'row between', style: 'margin-bottom:10px' }, h('b', {}, st.status === 'starting' ? '正在启动…' : st.status === 'stopping' ? '正在结束…' : '同传中'), clock),
    h('div', { class: 'muted small', style: 'margin-bottom:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis' }, st.title),
    h('div', { class: 'stack', style: 'margin-bottom:12px' },
      h('div', {}, h('span', { class: `dot ${dotClass(st.out.state)}` }), `我说中文 → 对方听译音：${STATE_TEXT[st.out.state] ?? st.out.state}`),
      h('div', {}, h('span', { class: `dot ${dotClass(st.in.state)}` }), `对方说话 → 中文字幕：${STATE_TEXT[st.in.state] ?? st.in.state}`),
    ),
  );
  for (const m of [st.out.state === 'error' ? st.out.message : '', st.in.state === 'error' ? st.in.message : ''].filter(Boolean)) {
    app.append(h('div', { class: 'callout err', style: 'margin-bottom:8px' }, m!));
  }
  if (here && st.status === 'running' && !st.micHooked) {
    app.append(h('div', { class: 'callout warn', style: 'margin-bottom:8px' }, '还没接管到会议的麦克风：请刷新会议页面重新入会（或在会议里关掉再打开麦克风）。在此之前对方听到的是你的原声。'));
  }
  for (const w of st.warnings) app.append(h('div', { class: 'callout warn', style: 'margin-bottom:8px' }, w));
  if (!here && st.tabId !== null) {
    app.append(
      h('div', { class: 'callout info', style: 'margin-bottom:8px' }, '同传正在另一个标签页运行。', ' ', h('a', { onclick: () => void chrome.tabs.update(st.tabId!, { active: true }) }, '切换过去')),
    );
  }
  app.append(
    h(
      'label',
      { class: 'row', style: 'margin:10px 0 14px;font-size:14px' },
      h('input', {
        type: 'checkbox',
        checked: st.passthrough,
        onchange: async (e: Event) => {
          await send({ type: 'passthrough', on: (e.target as HTMLInputElement).checked });
          void render();
        },
      }),
      '原声直通（我自己直接说外语时打开）',
    ),
    h(
      'button',
      {
        class: 'big stop',
        disabled: st.status !== 'running',
        onclick: async () => {
          await send({ type: 'stop' });
          void render();
        },
      },
      '结束同传',
    ),
  );
}

chrome.storage.session.onChanged.addListener(() => void render());
void render();
