import { OrderedPlayer } from '../../../browser/ordered-player';
import { useEffect, useRef, useState } from 'react';
import { decodeFrame, encodeAudioUp, ROOM_PROTOCOL_VERSION, type RoomPeer, type ServerMessage } from '@core/room/protocol';
import type { TranscriptSegment } from '@core/types';

type UiLang = 'zh' | 'es' | 'en';

const T = {
  zh: {
    title: '同传房间',
    name: '你的名字',
    namePh: '例如：王经理',
    pick: '选择你说的语言',
    join: '加入',
    joining: '正在加入…',
    hold: '按住说话',
    talking: '正在说…松开发送',
    continuous: '持续说话',
    continuousOn: '正在持续说话（点击停止）',
    headphones: '建议戴上耳机，你会听到其他语言发言的中文译音。',
    voice: '播放译音',
    leave: '离开',
    empty: '还没有人发言。按住下面的按钮说话。',
    peers: '在线',
    reconnecting: '连接断开，正在重连…',
    ended: '房间已关闭。',
    micDenied: '无法使用麦克风：请在浏览器设置中允许本网页使用麦克风。',
    translating: '翻译中…',
    failed: '（翻译失败）',
    host: '主持人',
  },
  es: {
    title: 'Sala de interpretación',
    name: 'Tu nombre',
    namePh: 'Por ejemplo: Carlos',
    pick: 'Elige el idioma que hablas',
    join: 'Unirse',
    joining: 'Uniéndose…',
    hold: 'Mantén pulsado para hablar',
    talking: 'Hablando… suelta para enviar',
    continuous: 'Hablar sin pulsar',
    continuousOn: 'Hablando sin pulsar (toca para parar)',
    headphones: 'Usa auriculares: oirás la interpretación al español de lo que digan en chino.',
    voice: 'Voz de la interpretación',
    leave: 'Salir',
    empty: 'Nadie ha hablado todavía. Mantén pulsado el botón para hablar.',
    peers: 'Conectados',
    reconnecting: 'Conexión perdida, reconectando…',
    ended: 'La sala se ha cerrado.',
    micDenied: 'No se puede usar el micrófono: permite el acceso al micrófono en el navegador.',
    translating: 'Traduciendo…',
    failed: '(traducción fallida)',
    host: 'Anfitrión',
  },
  en: {
    title: 'Interpreting room',
    name: 'Your name',
    namePh: 'e.g. John',
    pick: 'Choose the language you speak',
    join: 'Join',
    joining: 'Joining…',
    hold: 'Hold to talk',
    talking: 'Talking… release to send',
    continuous: 'Talk hands-free',
    continuousOn: 'Talking hands-free (tap to stop)',
    headphones: 'Wear headphones: you will hear an English interpretation of what is said in Chinese.',
    voice: 'Interpretation voice',
    leave: 'Leave',
    empty: 'Nobody has spoken yet. Hold the button below to talk.',
    peers: 'Online',
    reconnecting: 'Connection lost, reconnecting…',
    ended: 'The room has been closed.',
    micDenied: 'Cannot use the microphone: allow microphone access for this page in your browser.',
    translating: 'Translating…',
    failed: '(translation failed)',
    host: 'Host',
  },
};

const isZh = (code: string) => code.toLowerCase().startsWith('zh');

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

  const ws = useRef<WebSocket | null>(null);
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
  const listRef = useRef<HTMLDivElement>(null);
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
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const sock = new WebSocket(`${proto}://${location.host}/ws`);
    sock.binaryType = 'arraybuffer';
    ws.current = sock;
    sock.onopen = () => {
      retry.current = 0;
      sock.send(JSON.stringify({ t: 'join', name, lang: ui === 'zh' ? 'zh-CN' : remoteCode, token, v: ROOM_PROTOCOL_VERSION }));
    };
    sock.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        const f = decodeFrame(new Uint8Array(e.data));
        if (f?.kind === 'tts') play(f.segmentId, f.pcm, f.sampleRate);
        return;
      }
      const msg = JSON.parse(e.data as string) as ServerMessage;
      switch (msg.t) {
        case 'audioEnd':
          player.current?.end(msg.segmentId);
          break;
        case 'welcome':
          myId.current = msg.id;
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
      const delay = Math.min(10000, 1000 * 2 ** retry.current++);
      setTimeout(connect, delay);
    };
  };

  const join = async () => {
    setJoining(true);
    setError('');
    localStorage.setItem('mi-name', name);
    localStorage.setItem('mi-lang', ui);
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

  if (!token) return <div style={{ padding: 24 }}>链接缺少房间码，请重新扫码。 / Falta el código de la sala, escanea de nuevo. / The link has no room code, scan again.</div>;

  if (!joined) {
    return (
      <div style={{ padding: '32px 22px', maxWidth: 480, margin: '0 auto' }}>
        <h1 style={{ fontSize: 24, margin: '8px 0 4px' }}>同传房间 · {foreign === 'en' ? 'Room' : 'Sala'}</h1>
        <p style={{ opacity: 0.7, marginTop: 0 }}>中文 ⇄ {foreign === 'en' ? 'English' : 'Español'}</p>
        <p style={{ marginTop: 28, marginBottom: 10, opacity: 0.85 }}>{t.pick}</p>
        <div style={{ display: 'flex', gap: 10 }}>
          {(['zh', foreign] as const).map((l) => (
            <button key={l} onClick={() => setUi(l)} style={{ ...choice, ...(ui === l ? choiceOn : {}) }}>
              {l === 'zh' ? '中文' : l === 'en' ? 'English' : 'Español'}
            </button>
          ))}
        </div>
        <p style={{ marginTop: 22, marginBottom: 8, opacity: 0.85 }}>{t.name}</p>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t.namePh} maxLength={24} style={input} />
        <button onClick={join} disabled={joining} style={{ ...bigBtn, marginTop: 26, width: '100%' }}>
          {joining ? t.joining : t.join}
        </button>
        <p style={{ opacity: 0.6, fontSize: 13, marginTop: 18, lineHeight: 1.6 }}>🎧 {t.headphones}</p>
        {error && <p style={{ color: '#fca5a5' }}>{error}</p>}
      </div>
    );
  }

  const mine = (s: TranscriptSegment) => (ui === 'zh' ? isZh(s.srcLang) : !isZh(s.srcLang));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10, borderBottom: '1px solid #222836' }}>
        <b style={{ flex: 1 }}>{t.title}</b>
        <span style={{ fontSize: 12, opacity: 0.7 }}>
          {t.peers} {peers.length}
        </span>
        <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={voiceOn} onChange={(e) => setVoiceOn(e.target.checked)} /> {t.voice}
        </label>
        <button onClick={leave} style={smallBtn}>
          {t.leave}
        </button>
      </div>
      {status === 'reconnecting' && <div style={banner}>{t.reconnecting}</div>}
      {status === 'ended' && <div style={banner}>{t.ended}</div>}
      {error && status !== 'ended' && <div style={{ ...banner, background: '#7f1d1d' }}>{error}</div>}
      <div ref={listRef} style={{ flex: 1, overflow: 'auto', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {segs.length === 0 && <div style={{ opacity: 0.6, textAlign: 'center', marginTop: 40 }}>{t.empty}</div>}
        {segs.map((s) => {
          const own = mine(s);
          const main = own ? s.srcText : s.status === 'done' || s.status === 'skipped' ? s.dstText : s.status === 'failed' ? t.failed : t.translating;
          const sub = own ? s.dstText : s.srcText;
          const who = s.speaker === 'me' ? t.host : s.speaker === 'them' ? '—' : s.speaker;
          return (
            <div key={s.id} style={{ alignSelf: own ? 'flex-end' : 'flex-start', maxWidth: '88%' }}>
              <div style={{ fontSize: 12, opacity: 0.55, marginBottom: 3, textAlign: own ? 'right' : 'left' }}>{who}</div>
              <div style={{ background: own ? '#1e3a8a' : '#1f2937', borderRadius: 14, padding: '10px 13px' }}>
                <div style={{ fontSize: 18, lineHeight: 1.45 }}>{main}</div>
                {sub && <div style={{ fontSize: 13, opacity: 0.6, marginTop: 4 }}>{sub}</div>}
              </div>
            </div>
          );
        })}
        {partial && (
          <div style={{ opacity: 0.55, fontStyle: 'italic', fontSize: 14 }}>
            {partial.name}: {partial.text}
          </div>
        )}
      </div>
      <div style={{ padding: '14px 16px calc(14px + env(safe-area-inset-bottom))', borderTop: '1px solid #222836', display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center' }}>
        {!continuous && (
          <button
            onPointerDown={(e) => {
              e.preventDefault();
              void setTalk(true);
            }}
            onPointerUp={() => void setTalk(false)}
            onPointerLeave={() => talkingRef.current && void setTalk(false)}
            onPointerCancel={() => void setTalk(false)}
            onContextMenu={(e) => e.preventDefault()}
            style={{ ...talkBtn, background: talking ? '#dc2626' : '#2563eb', transform: talking ? 'scale(1.04)' : 'none' }}
          >
            {talking ? t.talking : t.hold}
          </button>
        )}
        <button
          onClick={() => {
            const next = !continuous;
            setContinuous(next);
            void setTalk(next);
          }}
          style={{ ...smallBtn, ...(continuous ? { background: '#dc2626', borderColor: '#dc2626', padding: '14px 18px', width: '100%' } : {}) }}
        >
          {continuous ? t.continuousOn : t.continuous}
        </button>
      </div>
    </div>
  );
}

const choice: React.CSSProperties = { flex: 1, padding: '16px 0', borderRadius: 14, border: '2px solid #374151', background: '#1f2937', color: '#fff', fontSize: 18, cursor: 'pointer' };
const choiceOn: React.CSSProperties = { borderColor: '#3b82f6', background: '#1e3a8a' };
const input: React.CSSProperties = { width: '100%', padding: '14px 12px', borderRadius: 12, border: '1px solid #374151', background: '#111827', color: '#fff', fontSize: 16 };
const bigBtn: React.CSSProperties = { padding: '16px 0', borderRadius: 14, border: 0, background: '#2563eb', color: '#fff', fontSize: 18, cursor: 'pointer' };
const smallBtn: React.CSSProperties = { padding: '7px 12px', borderRadius: 10, border: '1px solid #374151', background: 'transparent', color: '#fff', cursor: 'pointer' };
const talkBtn: React.CSSProperties = { width: '100%', padding: '26px 0', borderRadius: 18, border: 0, color: '#fff', fontSize: 20, fontWeight: 600, touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none', transition: 'transform .1s' };
const banner: React.CSSProperties = { background: '#78350f', padding: '8px 16px', fontSize: 13 };
