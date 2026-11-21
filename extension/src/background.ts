/**
 * Service worker: starts and stops sessions (tab capture needs the toolbar click), owns the
 * offscreen engine, keeps the popup's state in chrome.storage.session and saves finished meetings.
 * It holds no state in variables: it may be stopped at any time.
 */
import { headerRule } from './browser-context';
import { IDLE_STATE, loadAll, MAX_SAVED_MEETINGS, type FromOffscreen, type SavedMeeting, type SessionState, type ToBackground, type ToOffscreen, type DOmit } from './shared';

const OFFSCREEN = 'offscreen.html';

async function getState(): Promise<SessionState> {
  const r = await chrome.storage.session.get('state');
  return { ...IDLE_STATE, ...((r.state as SessionState | undefined) ?? {}) };
}

async function setState(patch: Partial<SessionState>): Promise<SessionState> {
  const next = { ...(await getState()), ...patch };
  await chrome.storage.session.set({ state: next });
  await chrome.action.setBadgeText({ text: next.status === 'running' ? '译' : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
  return next;
}

async function hasOffscreen(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType] });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN,
      reasons: ['USER_MEDIA' as chrome.offscreen.Reason, 'AUDIO_PLAYBACK' as chrome.offscreen.Reason],
      justification: '采集会议标签页的声音做实时识别，并播放翻译语音',
    });
  } catch (err) {
    if (!String(err).includes('single offscreen')) throw err;
  }
}

interface OffscreenReply {
  ok: boolean;
  error?: string;
  state?: Partial<SessionState>;
  meeting?: SavedMeeting | null;
}

async function toOffscreen(m: DOmit<ToOffscreen, 'target'>): Promise<OffscreenReply> {
  const r = (await chrome.runtime.sendMessage({ target: 'offscreen', ...m })) as OffscreenReply | undefined;
  return r ?? { ok: false, error: '翻译引擎没有响应' };
}

async function start(tabId: number) {
  const st = await getState();
  if (st.status === 'starting' || st.status === 'stopping') return st;
  if (st.status === 'running') {
    if (st.tabId === tabId) return st;
    await stop();
  }
  const tab = await chrome.tabs.get(tabId);
  await setState({ ...IDLE_STATE, status: 'starting', tabId, title: tab.title ?? '' });
  try {
    let streamId: string | null = null;
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    } catch (err) {
      console.warn('tab capture unavailable', err);
    }
    await ensureOffscreen();
    const data = await loadAll();
    const r = await toOffscreen({ type: 'start', tabId, title: tab.title ?? '', streamId, data } as DOmit<ToOffscreen, 'target'>);
    if (!r.ok) throw new Error(r.error);
    await setState(r.state ?? { status: 'running' });
    // Every frame of the meeting page connects to the engine.
    await chrome.tabs.sendMessage(tabId, { type: 'engine-start' }).catch(() => undefined);
    return await getState();
  } catch (err) {
    await closeOffscreen();
    return setState({ ...IDLE_STATE, error: err instanceof Error ? err.message : String(err) });
  }
}

async function stop() {
  const st = await getState();
  if (st.status !== 'running' && st.status !== 'starting') return st;
  await setState({ status: 'stopping' });
  let meeting: SavedMeeting | null = null;
  try {
    if (await hasOffscreen()) meeting = (await toOffscreen({ type: 'stop' })).meeting ?? null;
  } catch (err) {
    console.warn('stop failed', err);
  }
  await finish(meeting, st.tabId);
  return getState();
}

async function finish(meeting: SavedMeeting | null, tabId: number | null) {
  // Whatever fails here, the extension must end up idle again (never stuck in "stopping").
  let error: string | undefined;
  try {
    if (meeting) await saveMeeting(meeting);
  } catch (err) {
    error = `这场会议没能保存：${err instanceof Error ? err.message : String(err)}`;
  }
  try {
    if (tabId !== null) await chrome.tabs.sendMessage(tabId, { type: 'engine-stop' }).catch(() => undefined);
    await closeOffscreen();
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: (await chrome.declarativeNetRequest.getSessionRules()).map((r) => r.id) });
  } finally {
    await setState({ ...IDLE_STATE, lastMeetingId: error ? undefined : meeting?.meta.id, ...(error ? { error } : {}) });
  }
}

async function closeOffscreen() {
  if (await hasOffscreen()) await chrome.offscreen.closeDocument().catch(() => undefined);
}

/**
 * Keeps the newest meetings. The extension's storage is limited (about 10 MB): when it is full, the
 * oldest meetings make room for the new one, never the other way round.
 */
async function saveMeeting(m: SavedMeeting) {
  const r = await chrome.storage.local.get('meetings');
  let list = ((r.meetings as SavedMeeting[] | undefined) ?? []).filter((x) => x.meta.id !== m.meta.id);
  list.unshift(m);
  list = list.slice(0, MAX_SAVED_MEETINGS);
  for (;;) {
    try {
      await chrome.storage.local.set({ meetings: list });
      return;
    } catch (err) {
      if (list.length <= 1 || !/quota/i.test(err instanceof Error ? err.message : String(err))) throw err;
      list = list.slice(0, Math.max(1, Math.floor(list.length * 0.7)));
    }
  }
}

/** Stable small rule id per WebSocket endpoint. */
function ruleId(url: string): number {
  const u = new URL(url);
  let h = 7;
  for (const c of `${u.host}${u.pathname}`) h = (h * 31 + c.charCodeAt(0)) % 1_000_000;
  return h + 1;
}

// Keys live in chrome.storage.local: only the extension's own pages may read it, never the
// content scripts running inside meeting websites (they do not need it).
void chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => undefined);

/** Messages from the extension's own pages (popup, options, offscreen) — never from a web page's content script. */
const fromExtensionPage = (sender: chrome.runtime.MessageSender) => sender.id === chrome.runtime.id && (sender.url ?? '').startsWith(`chrome-extension://${chrome.runtime.id}/`);

chrome.runtime.onMessage.addListener((msg: ToBackground | FromOffscreen | { type: 'bridgeReady' }, sender, reply) => {
  if (!msg || typeof msg !== 'object') return;
  // Content scripts (inside meeting pages) may only ask whether interpretation is running there.
  if (!fromExtensionPage(sender) && (msg as { type?: string }).type !== 'bridgeReady') return;
  (async () => {
    if ('target' in msg && msg.target === 'background') {
      switch (msg.type) {
        case 'status': {
          const st = await getState();
          if (st.status === 'idle' || st.status === 'stopping') return reply({ ok: true });
          return reply(await setState(msg.patch));
        }
        case 'wsHeaders': {
          const rule = headerRule(ruleId(msg.url), msg.url, msg.headers);
          await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [rule.id], addRules: [rule] });
          return reply({ ok: true });
        }
        case 'ended':
          await finish(msg.meeting, (await getState()).tabId);
          return reply({ ok: true });
      }
      return;
    }
    if ('target' in msg) return; // for the offscreen document
    switch (msg.type) {
      case 'start':
        return reply(await start(msg.tabId));
      case 'stop':
        return reply(await stop());
      case 'passthrough':
        await toOffscreen({ type: 'passthrough', on: msg.on });
        return reply(await setState({ passthrough: msg.on }));
      case 'state':
        return reply(await getState());
      case 'bridgeReady': {
        const st = await getState();
        return reply({ running: st.status === 'running' && st.tabId === sender.tab?.id });
      }
    }
  })().catch((err: unknown) => reply({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const st = await getState();
  if (st.tabId === tabId && st.status === 'running') await stop();
});

// A browser restart loses the engine: never show a stale "running" state.
chrome.runtime.onStartup.addListener(() => void chrome.storage.session.set({ state: IDLE_STATE }));
chrome.runtime.onInstalled.addListener(async (d) => {
  if (d.reason === 'install') await chrome.runtime.openOptionsPage();
});
