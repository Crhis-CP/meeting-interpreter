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

async function toOffscreen(m: DOmit<ToOffscreen, 'target'>): Promise<{ ok: boolean; error?: string; state?: Partial<SessionState> }> {
  const r = (await chrome.runtime.sendMessage({ target: 'offscreen', ...m })) as { ok: boolean; error?: string; state?: Partial<SessionState> } | undefined;
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
  try {
    if (await hasOffscreen()) await toOffscreen({ type: 'stop' });
  } catch (err) {
    console.warn('stop failed', err);
  }
  // `ended` from the engine finishes the stop; make sure we end up idle even without it.
  const after = await getState();
  if (after.status === 'stopping') await finish(null, st.tabId);
  return getState();
}

async function finish(meeting: SavedMeeting | null, tabId: number | null) {
  if (meeting) await saveMeeting(meeting);
  if (tabId !== null) await chrome.tabs.sendMessage(tabId, { type: 'engine-stop' }).catch(() => undefined);
  await closeOffscreen();
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: (await chrome.declarativeNetRequest.getSessionRules()).map((r) => r.id) });
  await setState({ ...IDLE_STATE, lastMeetingId: meeting?.meta.id });
}

async function closeOffscreen() {
  if (await hasOffscreen()) await chrome.offscreen.closeDocument().catch(() => undefined);
}

async function saveMeeting(m: SavedMeeting) {
  const r = await chrome.storage.local.get('meetings');
  const list = ((r.meetings as SavedMeeting[] | undefined) ?? []).filter((x) => x.meta.id !== m.meta.id);
  list.unshift(m);
  await chrome.storage.local.set({ meetings: list.slice(0, MAX_SAVED_MEETINGS) });
}

/** Stable small rule id per WebSocket endpoint. */
function ruleId(url: string): number {
  const u = new URL(url);
  let h = 7;
  for (const c of `${u.host}${u.pathname}`) h = (h * 31 + c.charCodeAt(0)) % 1_000_000;
  return h + 1;
}

chrome.runtime.onMessage.addListener((msg: ToBackground | FromOffscreen | { type: 'bridgeReady' }, sender, reply) => {
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
