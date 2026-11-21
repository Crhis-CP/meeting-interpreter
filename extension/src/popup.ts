import { pingDesktop } from '@core/bridge/desktop';
import { checkForUpdate } from '../../src/main/update-check';
import { consoleLogger, createBrowserContext } from './browser-context';
import { baseOf, REMOTE_CHOICES, withRemoteBase } from '@core/lang/languages';
import { desktopMissing, h, keyField, seg, settingsProblem } from './dom';
import { offlineMt, usesDesktop } from './engine-providers';
import { IDLE_STATE, KEY_LINKS, loadAll, MEETING_SITES, missingKey, PLAN_NAMES, withDefaults, type ProviderSet, type SessionState, type ToBackground } from './shared';

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

/**
 * Whether the desktop app is running (the free tier's recognition and voices come from it): asked
 * when the popup opens and every 5 s, kept here so the popup's frequent redraws always show it
 * (a check that answered after a redraw used to be lost). null until the first answer.
 */
let desktop: boolean | null = null;
let desktopTimer: number | undefined;
function watchDesktop(): void {
  if (desktopTimer !== undefined) return;
  const check = () =>
    void pingDesktop(createBrowserContext(consoleLogger('popup'), async () => undefined)).then((ok) => {
      const was = desktop;
      desktop = !!ok;
      if (was !== desktop) void render();
    });
  check();
  desktopTimer = window.setInterval(check, 5000);
}

async function render() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const data = await loadAll();
  const st = await send({ type: 'state' });
  const s = data.settings;
  const running = st.status === 'running' || st.status === 'starting' || st.status === 'stopping';
  const here = running && st.tabId === tab?.id;
  clearInterval(timer);
  const main = h('main');
  app.replaceChildren(
    h('header', { class: 'row between', style: 'margin-bottom:16px' },
      h('h1', { class: 'row' }, h('img', { src: 'icons/icon-32.png', width: 24, height: 24, alt: '' }), '会议同传'),
      h('button', { class: 'link', style: 'font-size:18px', 'aria-label': '设置', title: '设置', onclick: () => openOptions() }, '⚙'),
    ),
    main,
  );

  void showUpdate();
  if (!running) {
    const save = async (patch: Partial<typeof s>) => {
      await chrome.storage.local.set({ settings: withDefaults({ ...s, ...patch }) });
      void render();
    };
    // Free and 高级 are the choices here; any other set (chosen in the options page) shows as a third.
    const plans = (['free', 'dashscope'] as ProviderSet[]).concat(s.providers === 'free' || s.providers === 'dashscope' ? [] : [s.providers]);
    const plan = seg('方案', plans.map((p) => [p, PLAN_NAMES[p]] as const), s.providers, (v) => void save({ providers: v }));
    if (plans[2]) plan.querySelector(`input[value="${plans[2]}"]`)?.addEventListener('click', () => openOptions());
    main.append(
      h('div', { class: 'pair' },
        h('span', { 'aria-hidden': 'true' }, '中文 ⇄'),
        seg('对方说', REMOTE_CHOICES.map((c) => [c.base, c.name] as const), baseOf(s.remote) as 'es' | 'en', (v) => void save({ remote: withRemoteBase(s.remote, v) })),
      ),
      plan,
    );

    // The key this tier needs: get it in one click, paste it here.
    const need = missingKey(s, data.secrets);
    if (need) {
      const info = KEY_LINKS[need];
      const form = keyField(need, info.label, false, info.url, async (v) => {
        if (!v) return;
        await chrome.storage.local.set({ secrets: { ...data.secrets, [need]: v } });
        void render();
      });
      form.classList.add('keybox');
      main.append(form);
    }
    const needsDesktop = usesDesktop(s);
    if (needsDesktop) watchDesktop();
    const problem = need ? 'key' : settingsProblem(data) ?? (needsDesktop && desktop === false ? 'desktop' : null);
    if (problem && !need && problem !== 'desktop') main.append(h('div', { class: 'callout warn', role: 'status' }, problem, ' ', h('button', { class: 'link', onclick: () => openOptions() }, '去设置')));
    // The free tier needs the desktop app running: said here, and starting waits for it.
    if (needsDesktop) main.append(desktop === false ? desktopMissing() : desktop === null ? h('p', { class: 'note', role: 'status' }, '正在检测电脑版…') : '');
    if ([s.out.mt, s.in.mt].includes('offline')) {
      const slot = h('div');
      main.append(slot);
      void offlineMt().missingBytes().then((missing) => {
        if (missing) slot.replaceWith(h('div', { class: 'callout warn', role: 'status' }, h('button', { class: 'link', onclick: () => openOptions('#offline') }, `下载离线翻译（约 ${Math.round(missing / 1_000_000)} MB）`)));
      });
    }
    if (st.error) main.append(h('div', { class: 'callout err', role: 'alert' }, st.error));
    main.append(
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
      isMeetingSite(tab?.url) ? '' : h('p', { class: 'note', role: 'status' }, '当前标签页不是会议'),
    );
    app.append(
      h('nav', { class: 'row between small', style: 'margin-top:14px', 'aria-label': '更多' },
        h('button', { class: 'link', onclick: () => openOptions('#test') }, '测试一下'),
        h('a', { href: 'https://crhis-cp.github.io/meeting-interpreter/guide.html#web', target: '_blank' }, '新手上手'),
        h('button', { class: 'link', onclick: () => openOptions('#glossary') }, '术语表'),
        h('button', { class: 'link', onclick: () => openOptions(st.lastMeetingId ? `#meeting=${st.lastMeetingId}` : '#meetings') }, '会议记录'),
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
  const line = (who: string, d: SessionState['out']) => h('li', {}, h('span', { class: `dot ${dotClass(d.state)}`, 'aria-hidden': 'true' }), `${who}：${STATE_TEXT[d.state] ?? d.state}`);
  main.append(
    h('div', { class: 'row between', style: 'margin-bottom:6px' }, h('b', {}, st.status === 'starting' ? '正在启动…' : st.status === 'stopping' ? '正在结束…' : '同传中'), clock),
    h('div', { class: 'muted small', style: 'margin-bottom:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis' }, st.title),
    h('ul', { class: 'plain stack', role: 'status', style: 'margin-bottom:12px;font-size:14px' }, line('我说话', st.out), line('对方说话', st.in)),
  );
  for (const m of [st.out.state === 'error' ? st.out.message : '', st.in.state === 'error' ? st.in.message : ''].filter(Boolean)) {
    main.append(h('div', { class: 'callout err', role: 'alert' }, m!));
  }
  if (here && st.status === 'running' && !st.micHooked) {
    main.append(h('div', { class: 'callout warn', role: 'status' }, '对方现在听到的还是你的原声：在会议里把麦克风关掉再打开（或重新选一次麦克风）；还不行就刷新会议页面重新入会'));
  }
  for (const w of st.warnings) main.append(h('div', { class: 'callout warn', role: 'status' }, w));
  if (!here && st.tabId !== null) {
    main.append(
      h('div', { class: 'callout info', role: 'status' }, '同传在另一个标签页 ', h('button', { class: 'link', onclick: () => void chrome.tabs.update(st.tabId!, { active: true }) }, '切换过去')),
    );
  }
  main.append(
    h('label', { class: 'check', style: 'margin:10px 0 14px' },
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
    h('button', {
      class: 'big stop',
      disabled: st.status !== 'running',
      onclick: async () => {
        await send({ type: 'stop' });
        void render();
      },
    }, '结束同传'),
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
  app.prepend(h('div', { id: 'update', class: 'callout info', role: 'status' }, `新版本 ${latest} `, h('a', { href: 'https://crhis-cp.github.io/meeting-interpreter/', target: '_blank' }, '下载 ↗')));
}

chrome.storage.session.onChanged.addListener(() => void render());
void render();
