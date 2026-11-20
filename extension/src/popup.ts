import { pingDesktop } from '@core/bridge/desktop';
import { checkForUpdate } from '../../src/main/update-check';
import { consoleLogger, createBrowserContext } from './browser-context';
import { h, settingsProblem } from './dom';
import { offlineMt, usesDesktop } from './engine-providers';
import { DESKTOP_DOWNLOAD, IDLE_STATE, KEY_LINKS, loadAll, MEETING_SITES, missingKey, withDefaults, type SessionState, type ToBackground } from './shared';

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
    h(
      'div',
      { class: 'row between', style: 'margin-bottom:16px' },
      h('div', { class: 'row' }, h('img', { src: 'icons/icon-32.png', width: 24, height: 24, alt: '' }), h('h1', {}, '会议同传')),
      h('a', { class: 'small', title: '设置', onclick: () => openOptions() }, '⚙ 设置'),
    ),
  );

  void showUpdate();
  if (!running) {
    const isEn = s.remote.startsWith('en');
    const save = async (patch: Partial<typeof s>) => {
      await chrome.storage.local.set({ settings: withDefaults({ ...s, ...patch }) });
      void render();
    };
    const other = s.providers !== 'free' && s.providers !== 'dashscope';
    app.append(
      h('div', { class: 'label' }, '对方说'),
      h('div', { class: 'seg' },
        h('button', { class: isEn ? '' : 'on', onclick: () => isEn && void save({ remote: 'es-MX' }) }, '西班牙语'),
        h('button', { class: isEn ? 'on' : '', onclick: () => isEn || void save({ remote: 'en-US' }) }, 'English'),
      ),
      h('div', { class: 'label' }, '方案'),
      h('div', { class: 'seg' },
        h('button', { class: s.providers === 'free' ? 'on' : '', onclick: () => void save({ providers: 'free' }) }, '免费'),
        h('button', { class: s.providers === 'dashscope' ? 'on' : '', onclick: () => void save({ providers: 'dashscope' }) }, '高级 · 最准'),
        other ? h('button', { class: 'on', onclick: () => openOptions() }, { azure: 'Azure', custom: '自定义', demo: '演示' }[s.providers as 'azure'] ?? '自定义') : null,
      ),
    );

    // The key this tier needs: get it in one click, paste it here.
    const need = missingKey(s, data.secrets);
    if (need) {
      const info = KEY_LINKS[need];
      const input = h('input', { type: 'password', placeholder: '粘贴 Key', autocomplete: 'off' });
      app.append(
        h('div', { class: 'keybox' },
          h('div', { class: 'row between' }, h('b', {}, info.label), h('a', { href: info.url, target: '_blank', class: 'btn sm primary' }, '去获取 ↗')),
          h('div', { class: 'muted small' }, info.hint),
          h('div', { class: 'row' }, input, h('button', {
            class: 'btn',
            onclick: async () => {
              const v = input.value.trim();
              if (!v) return;
              await chrome.storage.local.set({ secrets: { ...data.secrets, [need]: v } });
              void render();
            },
          }, '保存')),
        ),
      );
    }
    const problem = need ? 'key' : settingsProblem(data);
    if (problem && !need) app.append(h('div', { class: 'callout warn' }, problem, ' ', h('a', { onclick: () => openOptions() }, '去设置')));

    if (usesDesktop(s)) {
      const slot = h('div');
      app.append(slot);
      void pingDesktop(createBrowserContext(consoleLogger('popup'), async () => undefined)).then((ok) => {
        if (!ok) slot.replaceWith(h('div', { class: 'callout warn' }, '免费版要先打开电脑上的桌面客户端 ', h('a', { href: DESKTOP_DOWNLOAD, target: '_blank' }, '下载 ↗')));
      });
    }
    if ([s.out.mt, s.in.mt].includes('offline')) {
      const slot = h('div');
      app.append(slot);
      void offlineMt().missingBytes().then((missing) => {
        if (missing) slot.replaceWith(h('div', { class: 'callout warn' }, `第一次使用要下载离线翻译（约 ${Math.round(missing / 1_000_000)} MB） `, h('a', { onclick: () => openOptions('#offline') }, '去下载')));
      });
    }
    const onMeeting = isMeetingSite(tab?.url);
    if (st.error) app.append(h('div', { class: 'callout err' }, st.error));
    app.append(
      h('button', {
        class: 'big',
        disabled: busy || !!problem || !tab?.id,
        onclick: async () => {
          busy = true;
          void render();
          await send({ type: 'start', tabId: tab!.id! });
          busy = false;
          void render();
        },
      }, busy ? '正在启动…' : '开始同传'),
      onMeeting ? '' : h('div', { class: 'hint-line' }, '先在浏览器里打开会议、入会，再点开始'),
      h('div', { class: 'row between small', style: 'margin-top:12px' },
        h('a', { onclick: () => openOptions('#test') }, '测试一下'),
        h('a', { href: 'https://crhis-cp.github.io/meeting-interpreter/guide.html#web', target: '_blank' }, '新手上手'),
        h('a', { onclick: () => openOptions('#glossary') }, '术语表'),
        h('a', { onclick: () => openOptions(st.lastMeetingId ? `#meeting=${st.lastMeetingId}` : '#meetings') }, '会议记录'),
      ),
    );
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
      h('div', {}, h('span', { class: `dot ${dotClass(st.out.state)}` }), `我说话：${STATE_TEXT[st.out.state] ?? st.out.state}`),
      h('div', {}, h('span', { class: `dot ${dotClass(st.in.state)}` }), `对方说话：${STATE_TEXT[st.in.state] ?? st.in.state}`),
    ),
  );
  for (const m of [st.out.state === 'error' ? st.out.message : '', st.in.state === 'error' ? st.in.message : ''].filter(Boolean)) {
    app.append(h('div', { class: 'callout err' }, m!));
  }
  if (here && st.status === 'running' && !st.micHooked) {
    app.append(h('div', { class: 'callout warn', style: 'margin-bottom:8px' }, '对方现在听到的还是你的原声：请刷新会议页面重新入会'));
  }
  for (const w of st.warnings) app.append(h('div', { class: 'callout warn' }, w));
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
      '我直接说外语（不翻译）',
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

/** A quiet note when a newer version is on the download site (checked at most twice a day). */
async function showUpdate() {
  const { updateCheck } = (await chrome.storage.local.get('updateCheck')) as { updateCheck?: { at: number; version: string | null } };
  let latest = updateCheck?.version ?? null;
  if (!updateCheck || Date.now() - updateCheck.at > 12 * 3600_000) {
    const u = await checkForUpdate(chrome.runtime.getManifest().version, consoleLogger('update'));
    latest = u?.version ?? null;
    await chrome.storage.local.set({ updateCheck: { at: Date.now(), version: latest } });
  }
  if (!latest || document.getElementById('update')) return;
  app.prepend(h('div', { id: 'update', class: 'callout info' }, `有新版本 ${latest} `, h('a', { href: 'https://crhis-cp.github.io/meeting-interpreter/', target: '_blank' }, '去下载 ↗'), '（解压后替换原来的文件夹，再在扩展页点刷新）'));
}

chrome.storage.session.onChanged.addListener(() => void render());
void render();
