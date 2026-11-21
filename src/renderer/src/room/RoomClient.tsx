import { OrderedPlayer } from '../../../browser/ordered-player';
import { useEffect, useRef, useState } from 'react';
import { decodeFrame, encodeAudioUp, ROOM_PROTOCOL_VERSION, type RoomPeer, type ServerMessage } from '@core/room/protocol';
import type { TranscriptSegment } from '@core/types';
import { openHttp, openWebSocket, type RoomSocket } from './transport';

type UiLang = 'zh' | 'es' | 'en';

const T = {
  zh: {
    title: '同传房间',
    name: '你的名字',
    pick: '我说',
    join: '加入',
    joining: '正在加入…',
    hold: '按住说话',
    talking: '松开发送',
    continuous: '持续说话',
    voice: '播放译音',
    leave: '离开',
    empty: '还没有人发言',
    peers: '在线',
    reconnecting: '连接断开，正在重连…',
    ended: '房间已关闭。',
    micDenied: '无法使用麦克风：请在浏览器设置中允许本网页使用麦克风。',
    translating: '翻译中…',
    failed: '（翻译失败）',
    host: '主持人',
    unreachable: '连不上主持人的电脑：请确认手机和电脑连着同一个 Wi-Fi；还不行就请主持人发“公网链接”。',
    wechat: '在微信里可能用不了麦克风：点右上角“…”，选“在浏览器打开”。',
  },
  es: {
    title: 'Sala de interpretación',
    name: 'Tu nombre',
    pick: 'Hablo',
    join: 'Unirse',
    joining: 'Uniéndose…',
    hold: 'Mantén pulsado para hablar',
    talking: 'Suelta para enviar',
    continuous: 'Hablar sin pulsar',
    voice: 'Audio traducido',
    leave: 'Salir',
    empty: 'Nadie ha hablado todavía',
    peers: 'Conectados',
    reconnecting: 'Conexión perdida, reconectando…',
    ended: 'La sala se ha cerrado.',
    micDenied: 'No se puede usar el micrófono: permite el acceso al micrófono en el navegador.',
    translating: 'Traduciendo…',
    failed: '(traducción fallida)',
    host: 'Anfitrión',
    unreachable: 'No se puede conectar con el ordenador del anfitrión: comprueba que estáis en la misma Wi-Fi, o pide al anfitrión el “enlace público”.',
    wechat: 'En WeChat el micrófono puede no funcionar: toca “…” arriba a la derecha y elige “Abrir en el navegador”.',
  },
  en: {
    title: 'Interpreting room',
    name: 'Your name',
    pick: 'I speak',
    join: 'Join',
    joining: 'Joining…',
    hold: 'Hold to talk',
    talking: 'Release to send',
    continuous: 'Talk hands-free',
    voice: 'Translated audio',
    leave: 'Leave',
    empty: 'Nobody has spoken yet',
    peers: 'Online',
    reconnecting: 'Connection lost, reconnecting…',
    ended: 'The room has been closed.',
    micDenied: 'Cannot use the microphone: allow microphone access for this page in your browser.',
    translating: 'Translating…',
    failed: '(translation failed)',
    host: 'Host',
    unreachable: "Cannot reach the host's computer: check that you are on the same Wi-Fi, or ask the host for the public link.",
    wechat: 'The microphone may not work inside WeChat: tap “…” at the top right and choose “Open in browser”.',
  },
};
const LANG_NAMES = { zh: '中文', es: 'Español', en: 'English' } as const;

const isZh = (code: string) => code.toLowerCase().startsWith('zh');

/** iPhone (Safari 16.4+): what the page does with audio. "playback" is not muted by the silent switch. */
function setAudioSession(type: 'playback' | 'play-and-record'): void {
  const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
  if (session) session.type = type;
}

export function RoomClient() {
  const params = new URLSearchParams(location.search);
  const token = params.get('t') ?? '';
  // The room's other language, from the link (e.g. es-MX or en-US).
  const remoteCode = params.get('l') || 'es';
  const foreign: 'es' | 'en' = remoteCode.toLowerCase().startsWith('en') ? 'en' : 'es';
  const [ui, setUi] = useState<UiLang>(() => ((localStorage.getItem('mi-lang') ?? navigator.language).toLowerCase().startsWith('zh') ? 'zh' : foreign));
  const [name, setName] = useState(() => localStorage.getItem('mi-name') ?? '');
  const [joined, setJoined] = useState(false);
  const [joining, setJoining] = useState(false);
  const [status, setStatus] = useState<'ok' | 'reconnecting' | 'ended' | 'error'>('ok');
  const [error, setError] = useState('');
  const [segs, setSegs] = useState<TranscriptSegment[]>([]);
  const [partial, setPartial] = useState<{ name: string; text: string } | null>(null);
  const [peers, setPeers] = useState<RoomPeer[]>([]);
  const [talking, setTalking] = useState(false);
  const [continuous, setContinuous] = useState(false);
  const [voiceOn, setVoiceOn] = useState(true);
  const t = T[ui];

  const ws = useRef<RoomSocket | null>(null);
  /** Plain HTTPS instead of WebSocket (the browser would not open one; Safari on iPhone with the room's certificate). */
  const useHttp = useRef(false);
  /** Attempts in a row that never got through. */
  const failures = useRef(0);
  const ctx = useRef<AudioContext | null>(null);
  const micNode = useRef<AudioWorkletNode | null>(null);
  const micStream = useRef<MediaStream | null>(null);
  const workletLoaded = useRef(false);
  const talkingRef = useRef(false);
  const voiceRef = useRef(true);
  /** Translations of everyone in the room: whole sentences, in order, never two at once. */
  const player = useRef<OrderedPlayer | null>(null);
  const myId = useRef('');
  const retry = useRef(0);
  const leaving = useRef(false);
  const listRef = useRef<HTMLElement>(null);
  voiceRef.current = voiceOn;

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [segs, partial]);

  // iOS suspends audio when the screen locks or the page is hidden: resume when it comes back,
  // and keep the connection alive with a ping.
  useEffect(() => {
    const resume = () => void ctx.current?.resume().catch(() => undefined);
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('pointerdown', resume);
    const ping = setInterval(() => {
      if (ws.current?.readyState === 1) ws.current.send(JSON.stringify({ t: 'ping' }));
    }, 15000);
    return () => {
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('pointerdown', resume);
      clearInterval(ping);
    };
  }, []);

  const play = (segmentId: string, pcm: Int16Array, rate: number) => {
    const c = ctx.current;
    if (!c || !voiceRef.current || !pcm.length) return;
    player.current ??= new OrderedPlayer(c, c.destination, { lead: 0.05 });
    player.current.push(segmentId, pcm, rate);
  };

  const connect = () => {
    const sock = useHttp.current ? openHttp(token) : openWebSocket();
    ws.current = sock;
    let opened = false;
    sock.onopen = () => {
      opened = true;
      failures.current = 0;
      retry.current = 0;
      sock.send(JSON.stringify({ t: 'join', name, lang: ui === 'zh' ? 'zh-CN' : remoteCode, token, v: ROOM_PROTOCOL_VERSION }));
    };
    sock.onmessage = (data) => {
      if (data instanceof ArrayBuffer) {
        const f = decodeFrame(new Uint8Array(data));
        if (f?.kind === 'tts') play(f.segmentId, f.pcm, f.sampleRate);
        return;
      }
      const msg = JSON.parse(data) as ServerMessage;
      switch (msg.t) {
        case 'audioEnd':
          player.current?.end(msg.segmentId);
          break;
        case 'welcome':
          myId.current = msg.id;
          setError('');
          setJoined(true);
          setJoining(false);
          setStatus('ok');
          setSegs(msg.history);
          if (talkingRef.current) sock.send(JSON.stringify({ t: 'talk', on: true }));
          break;
        case 'peers':
          setPeers(msg.peers);
          break;
        case 'partial':
          setPartial(msg.text ? { name: msg.name, text: msg.text } : null);
          break;
        case 'segment':
          setSegs((list) => {
            const i = list.findIndex((x) => x.id === msg.seg.id);
            const next = i >= 0 ? list.map((x, j) => (j === i ? msg.seg : x)) : [...list, msg.seg];
            return next.slice(-200);
          });
          if (msg.seg.status !== 'translating') setPartial(null);
          break;
        case 'error':
          setError(msg.message);
          if (msg.fatal) {
            leaving.current = true;
            setStatus('error');
            setJoining(false);
          }
          break;
        case 'ended':
          leaving.current = true;
          setStatus('ended');
          break;
      }
    };
    sock.onclose = () => {
      if (leaving.current) return;
      setStatus('reconnecting');
      if (!opened) {
        failures.current++;
        // A WebSocket that never opened: the browser refuses it (or the network does). Plain
        // HTTPS to the same address works where the page itself loaded: switch at once.
        if (sock.kind === 'ws' && !useHttp.current) {
          useHttp.current = true;
          setTimeout(connect, 0);
          return;
        }
        if (failures.current >= 3) setError(t.unreachable);
      }
      const delay = Math.min(10000, 1000 * 2 ** retry.current++);
      setTimeout(connect, delay);
    };
  };

  const join = async () => {
    setJoining(true);
    setError('');
    localStorage.setItem('mi-name', name);
    localStorage.setItem('mi-lang', ui);
    // iPhone: with the ring/silent switch on silent, web audio is muted unless the page says it
    // plays media (Safari 16.4+). Safari moves to play-and-record by itself when the mic opens.
    setAudioSession('playback');
    // Audio must be unlocked inside the tap (iOS).
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx.current = new AC();
    player.current = null; // belongs to the old context
    // Worklet modules belong to one AudioContext; a new one (re-join) must load it again.
    workletLoaded.current = false;
    await ctx.current.resume().catch(() => undefined);
    try {
      await (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<unknown> } }).wakeLock?.request('screen');
    } catch {
      /* not supported */
    }
    leaving.current = false;
    connect();
  };

  const ensureMic = async (): Promise<boolean> => {
    if (micNode.current) return true;
    const c = ctx.current!;
    setAudioSession('play-and-record');
    try {
      micStream.current = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
      if (!workletLoaded.current) {
        await c.audioWorklet.addModule(new URL('./pcm-worklet.js', document.baseURI).toString());
        workletLoaded.current = true;
      }
      const node = new AudioWorkletNode(c, 'pcm-capture', { numberOfInputs: 1, numberOfOutputs: 0 });
      node.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer }>) => {
        if (!talkingRef.current || ws.current?.readyState !== 1) return;
        ws.current.send(encodeAudioUp(new Int16Array(e.data.pcm)));
      };
      c.createMediaStreamSource(micStream.current).connect(node);
      micNode.current = node;
      return true;
    } catch {
      setError(t.micDenied);
      return false;
    }
  };

  const releaseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Closes the microphone a moment after talking stops: on iPhones an open mic sends all audio to
   * the quiet earpiece, so listeners without headphones hear translations better with it closed. */
  const releaseMicSoon = () => {
    if (releaseTimer.current) clearTimeout(releaseTimer.current);
    releaseTimer.current = setTimeout(() => {
      if (talkingRef.current) return;
      micStream.current?.getTracks().forEach((tr) => tr.stop());
      micNode.current?.disconnect();
      micNode.current = null;
      micStream.current = null;
      setAudioSession('playback');
    }, 2000);
  };

  const pressSeq = useRef(0);

  const setTalk = async (on: boolean) => {
    if (releaseTimer.current) clearTimeout(releaseTimer.current);
    // A release that happens while the microphone is still opening wins over the press.
    const seq = ++pressSeq.current;
    if (on && !(await ensureMic())) return;
    if (seq !== pressSeq.current) return;
    talkingRef.current = on;
    setTalking(on);
    if (ws.current?.readyState === 1) ws.current.send(JSON.stringify({ t: 'talk', on }));
    if (!on) releaseMicSoon();
  };

  const leave = () => {
    leaving.current = true;
    void setTalk(false);
    ws.current?.close();
    micStream.current?.getTracks().forEach((tr) => tr.stop());
    micNode.current = null;
    micStream.current = null;
    setJoined(false);
  };

  if (!token) return <p role="alert" style={{ padding: 24 }}>链接缺少房间码，请重新扫码。 / Falta el código de la sala, escanea de nuevo. / The link has no room code, scan again.</p>;

  if (!joined) {
    // The room's language pair is the title; then my language, my name, join.
    return (
      <main className="join">
        <h1>中文 ⇄ {LANG_NAMES[foreign]}</h1>
        {/MicroMessenger/i.test(navigator.userAgent) && <p role="note" className="err">{t.wechat}</p>}
        <div className="label" id="pick">{t.pick}</div>
        <div className="choices" role="radiogroup" aria-labelledby="pick">
          {(['zh', foreign] as const).map((l) => (
            <label key={l} className="choice">
              <input type="radio" name="lang" checked={ui === l} onChange={() => setUi(l)} />
              <span>{LANG_NAMES[l]}</span>
            </label>
          ))}
        </div>
        <label className="label" htmlFor="name">{t.name}</label>
        <input id="name" className="field" value={name} onChange={(e) => setName(e.target.value)} maxLength={24} autoComplete="name" />
        <button className="primary" onClick={join} disabled={joining}>
          {joining ? t.joining : t.join}
        </button>
        {error && <p role="alert" className="err">{error}</p>}
      </main>
    );
  }

  const mine = (s: TranscriptSegment) => (ui === 'zh' ? isZh(s.srcLang) : !isZh(s.srcLang));
  return (
    <div className="room">
      <header className="bar">
        <h1 className="sr-only">{t.title}</h1>
        <span className="peers">{t.peers} {peers.length}</span>
        <label>
          <input type="checkbox" role="switch" checked={voiceOn} onChange={(e) => setVoiceOn(e.target.checked)} /> {t.voice}
        </label>
        <button className="small" onClick={leave}>{t.leave}</button>
      </header>
      {status === 'reconnecting' && <div role="status" className="banner">{t.reconnecting}</div>}
      {status === 'ended' && <div role="status" className="banner">{t.ended}</div>}
      {error && status !== 'ended' && <div role="alert" className="banner err">{error}</div>}
      <main ref={listRef} className="log">
        {segs.length === 0 && <p className="empty">{t.empty}</p>}
        {segs.map((s) => {
          const own = mine(s);
          const shown = s.status === 'done' || s.status === 'skipped';
          const main = own ? s.srcText : shown ? s.dstText : s.status === 'failed' ? t.failed : t.translating;
          const sub = own ? s.dstText : s.srcText;
          const who = s.speaker === 'me' ? t.host : s.speaker === 'them' ? '—' : s.speaker;
          return (
            <div key={s.id} className={own ? 'msg own' : 'msg'}>
              <div className="who">{who}</div>
              <div className="bubble">
                <div className="main" lang={own ? s.srcLang : shown ? s.dstLang : undefined}>{main}</div>
                {sub && <div className="sub" lang={own ? s.dstLang : s.srcLang}>{sub}</div>}
              </div>
            </div>
          );
        })}
        {partial && <div className="partial">{partial.name}: {partial.text}</div>}
      </main>
      <footer className="controls">
        {!continuous && (
          <button
            className={talking ? 'talk on' : 'talk'}
            onPointerDown={(e) => {
              e.preventDefault();
              void setTalk(true);
            }}
            onPointerUp={() => void setTalk(false)}
            onPointerLeave={() => talkingRef.current && void setTalk(false)}
            onPointerCancel={() => void setTalk(false)}
            onContextMenu={(e) => e.preventDefault()}
          >
            {talking ? t.talking : t.hold}
          </button>
        )}
        <button
          className="small"
          aria-pressed={continuous}
          onClick={() => {
            const next = !continuous;
            setContinuous(next);
            void setTalk(next);
          }}
        >
          {t.continuous}
        </button>
      </footer>
    </div>
  );
}
