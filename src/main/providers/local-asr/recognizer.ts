import { createRequire } from 'node:module';
import { ASR_RATE, int16ToFloat } from '@core/audio/pcm';
import { baseOf, type LangBase } from '@core/lang/languages';
import { ProviderError } from '@core/providers/types';
import type { LangCode } from '@core/types';
import { DEFAULT_FOREIGN, MODELS, modelFile, type ForeignModelId, type ModelId } from './models';
import type { ModelStatus } from './model-manager';

// ------------------------------------------------------------------ the parts of sherpa-onnx-node we use
// sherpa-onnx-node ships no TypeScript types; these mirror its JSDoc typedefs (types.js) for 2.0.x.

export interface SherpaVadConfig {
  sileroVad: {
    model: string;
    threshold: number;
    minSilenceDuration: number;
    minSpeechDuration: number;
    maxSpeechDuration: number;
    windowSize: number;
  };
  sampleRate: number;
  numThreads: number;
  provider: string;
  debug: boolean;
}

export interface SherpaSpeechSegment {
  /** Sample index (16 kHz) since the VAD was created. */
  start: number;
  samples: Float32Array;
}

export interface SherpaVad {
  acceptWaveform(samples: Float32Array): void;
  isEmpty(): boolean;
  /** `enableExternalBuffer` must be false under Electron (V8's memory cage forbids external buffers). */
  front(enableExternalBuffer?: boolean): SherpaSpeechSegment;
  pop(): void;
  flush(): void;
  reset(): void;
  /** Whether speech is going on right now (sherpa-onnx ≥ 1.10). */
  isDetected?(): boolean;
}

export interface SherpaOfflineRecognizerConfig {
  featConfig: { sampleRate: number; featureDim: number };
  modelConfig: {
    senseVoice?: { model: string; language: string; useInverseTextNormalization: number };
    whisper?: { encoder: string; decoder: string; language: string; task: string };
    transducer?: { encoder: string; decoder: string; joiner: string };
    /** 'nemo_transducer' for Parakeet. */
    modelType?: string;
    tokens: string;
    numThreads: number;
    provider: string;
    debug: boolean;
  };
}

export interface SherpaOfflineStream {
  acceptWaveform(wave: { samples: Float32Array; sampleRate: number }): void;
}

export interface SherpaOfflineRecognizer {
  createStream(): SherpaOfflineStream;
  decode(stream: SherpaOfflineStream): void;
  getResult(stream: SherpaOfflineStream): { text: string; lang?: string };
}

export interface SherpaOnnxModule {
  Vad: new (config: SherpaVadConfig, bufferSizeInSeconds: number) => SherpaVad;
  OfflineRecognizer: new (config: SherpaOfflineRecognizerConfig) => SherpaOfflineRecognizer;
  version?: string;
}

/**
 * Loads the native module. Call it in the process that will run recognition (the utility process).
 * A runtime require, not an import: sherpa-onnx-node is an optionalDependency, which electron-vite does
 * not externalize, and the bundler must not try to inline its `.node` binary.
 */
export function loadSherpaOnnx(): SherpaOnnxModule {
  try {
    const req = createRequire(import.meta.url);
    return req('sherpa-onnx-node') as SherpaOnnxModule;
  } catch (err) {
    throw new ProviderError(`无法加载本机识别引擎（sherpa-onnx）：${err instanceof Error ? err.message : String(err)}`, 'local', { cause: err });
  }
}

// ------------------------------------------------------------------ recogniser

/** What the recogniser needs from the ModelManager. */
export interface ModelLocator {
  status(id: string): ModelStatus;
  pathOf(id: string, file: string): string;
}

export interface VadTuning {
  /** Speech probability above which a 32 ms window counts as speech. */
  threshold: number;
  /** Seconds of silence that end a sentence. */
  minSilenceDuration: number;
  /** Shorter bursts are ignored. */
  minSpeechDuration: number;
  /** Longer speech is cut (the VAD then splits at the next short pause). */
  maxSpeechDuration: number;
}

export const DEFAULT_VAD: VadTuning = { threshold: 0.5, minSilenceDuration: 0.5, minSpeechDuration: 0.25, maxSpeechDuration: 10 };
/** Longest stretch of Spanish / English before it is cut at a pause (see the constructor). */
export const FOREIGN_MAX_SPEECH = 6;

export interface LocalRecognizerOptions {
  sherpa: SherpaOnnxModule;
  lang: LangCode;
  models: ModelLocator;
  /** One finished sentence; times are seconds since the first sample fed. */
  onFinal: (text: string, startSec: number, endSec: number) => void;
  /**
   * The sentence so far, while it is being spoken (SenseVoice, Parakeet: cheap enough to decode
   * again every `partialEverySec`), so translation can start on its first clauses.
   */
  onPartial?: (text: string) => void;
  /** Default 0.8 s (SenseVoice) / 1 s (Parakeet); 0 turns partial results off. */
  partialEverySec?: number;
  /**
   * Recogniser for Spanish and English. Default Parakeet; until it is downloaded, a Whisper model
   * an earlier version downloaded stands in (see pickForeign).
   */
  esModel?: ForeignModelId;
  /** Threads for the Spanish / English recogniser (SenseVoice uses at most 2). Default 2. */
  numThreads?: number;
  vad?: Partial<VadTuning>;
}

/** Silero VAD window at 16 kHz (sherpa-onnx docs and examples use 512 samples = 32 ms). */
export const VAD_WINDOW = 512;

/** Audio added before each VAD segment: Silero's onset detection can clip the first syllable (e.g. a short "No …"). */
export const PRE_ROLL_SECONDS = 0.2;

/** Whisper's well-known inventions on silence or noise (Spanish subtitle credits, sound annotations). */
const WHISPER_JUNK: RegExp[] = [
  /amara\.org/i,
  /^subt[ií]tul(os|ado)\b.*\bpor\b/i,
  /^[([]\s*(m[uú]sica|music|aplausos|risas|silencio|ruido)\s*[)\]]\.?$/i,
];

/** Normalises whitespace and drops results without any letter or digit (and Whisper's inventions). */
export function cleanText(raw: string, lang: LangBase): string {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!/[\p{L}\p{N}]/u.test(text)) return '';
  if (lang !== 'zh' && WHISPER_JUNK.some((re) => re.test(text))) return '';
  return text;
}

/** The chosen recogniser if it is downloaded; otherwise the best one that is (Parakeet, then Whisper small, then base). */
export function pickForeign(models: ModelLocator, preferred: ForeignModelId): ForeignModelId {
  if (models.status(preferred) === 'ready') return preferred;
  const order: ForeignModelId[] = ['parakeet-v3', 'whisper-small', 'whisper-base'];
  return order.find((id) => models.status(id) === 'ready') ?? preferred;
}

/**
 * Silero VAD cuts the 16 kHz stream into sentences; each sentence is decoded by an offline recogniser
 * (SenseVoice for Chinese, Whisper for Spanish). Decoding is synchronous: run this in a worker process.
 */
export class LocalRecognizer {
  readonly lang: LangBase;
  /** The recogniser model in use. */
  readonly model: ModelId;
  private readonly vad: SherpaVad;
  private readonly recognizer: SherpaOfflineRecognizer;
  private readonly tuning: VadTuning;
  private pending: Float32Array = new Float32Array(0);
  /** Recent audio by absolute sample index (what the VAD has seen), for the pre-roll. */
  private readonly history: Float32Array;
  private historyEnd = 0;
  /** Where the speech now going on started (absolute sample), or null in silence. */
  private speechFrom: number | null = null;
  private lastPartialAt = 0;
  private lastPartial = '';

  constructor(private readonly opts: LocalRecognizerOptions) {
    this.lang = baseOf(opts.lang);
    this.model = this.lang === 'zh' ? 'sensevoice' : pickForeign(opts.models, opts.esModel ?? DEFAULT_FOREIGN);
    const missing = (['silero-vad', this.model] as ModelId[]).filter((id) => opts.models.status(id) !== 'ready');
    if (missing.length) {
      throw new ProviderError(`本机离线识别模型还没有下载：${missing.map((id) => MODELS[id].label).join('、')}。请先下载模型再开始。`, 'local');
    }
    // Spanish, English: a long stretch of speech is cut at its next short pause after 6 s (Silero
    // then raises its threshold), so the first part is recognised and translated while the speaker
    // goes on (Chinese has partial results for that instead).
    this.tuning = { ...DEFAULT_VAD, ...(this.model === 'sensevoice' ? {} : { maxSpeechDuration: FOREIGN_MAX_SPEECH }), ...opts.vad };
    // A segment can start up to maxSpeechDuration (+ the silence that ends it) before the newest sample.
    this.history = new Float32Array(Math.ceil((this.tuning.maxSpeechDuration + 5) * ASR_RATE));
    const path = (id: ModelId, role: Parameters<typeof modelFile>[1]) => opts.models.pathOf(id, modelFile(id, role).name);
    // SenseVoice is light (and decodes partial results while Chinese is spoken): two threads.
    const numThreads = this.model === 'sensevoice' ? Math.min(2, opts.numThreads ?? 2) : (opts.numThreads ?? 2);

    this.vad = new opts.sherpa.Vad(
      {
        sileroVad: { model: path('silero-vad', 'vad'), ...this.tuning, windowSize: VAD_WINDOW },
        sampleRate: ASR_RATE,
        numThreads: 1,
        provider: 'cpu',
        debug: false,
      },
      60,
    );

    const modelConfig: SherpaOfflineRecognizerConfig['modelConfig'] =
      this.model === 'sensevoice'
        ? {
            senseVoice: { model: path('sensevoice', 'model'), language: 'zh', useInverseTextNormalization: 1 },
            tokens: path('sensevoice', 'tokens'),
            numThreads,
            provider: 'cpu',
            debug: false,
          }
        : this.model === 'parakeet-v3'
        ? {
            // Recognises the language itself (25 European languages), with punctuation.
            transducer: { encoder: path('parakeet-v3', 'encoder'), decoder: path('parakeet-v3', 'decoder'), joiner: path('parakeet-v3', 'joiner') },
            modelType: 'nemo_transducer',
            tokens: path('parakeet-v3', 'tokens'),
            numThreads,
            provider: 'cpu',
            debug: false,
          }
        : {
            whisper: { encoder: path(this.model, 'encoder'), decoder: path(this.model, 'decoder'), language: this.lang, task: 'transcribe' },
            tokens: path(this.model, 'tokens'),
            numThreads,
            provider: 'cpu',
            debug: false,
          };
    this.recognizer = new opts.sherpa.OfflineRecognizer({ featConfig: { sampleRate: ASR_RATE, featureDim: 80 }, modelConfig });
  }

  /** Feeds 16 kHz mono PCM; finished sentences are decoded and reported before this returns. */
  feed(pcm: Int16Array): void {
    if (!pcm.length) return;
    const input = int16ToFloat(pcm);
    let buf = input;
    if (this.pending.length) {
      buf = new Float32Array(this.pending.length + input.length);
      buf.set(this.pending);
      buf.set(input, this.pending.length);
    }
    let off = 0;
    for (; off + VAD_WINDOW <= buf.length; off += VAD_WINDOW) this.accept(buf.subarray(off, off + VAD_WINDOW));
    this.pending = buf.slice(off);
    this.drain();
    this.partial();
  }

  /**
   * Decodes the sentence being spoken, at most every `partialEverySec` (SenseVoice: 0.8 s;
   * Parakeet: 1 s — it decodes a second of speech in ~70 ms on 4 cores). Whisper is too slow for this.
   */
  private partial(): void {
    if (this.model !== 'sensevoice' && this.model !== 'parakeet-v3') return;
    const every = this.opts.partialEverySec ?? (this.model === 'sensevoice' ? 0.8 : 1);
    if (!this.opts.onPartial || every <= 0 || !this.vad.isDetected) return;
    if (!this.vad.isDetected()) {
      this.speechFrom = null;
      return;
    }
    // The VAD notices speech after minSpeechDuration: start a little earlier (with the pre-roll).
    this.speechFrom ??= Math.max(0, this.historyEnd - Math.round((this.tuning.minSpeechDuration + PRE_ROLL_SECONDS + 0.1) * ASR_RATE));
    if (this.historyEnd - this.lastPartialAt < every * ASR_RATE) return;
    this.lastPartialAt = this.historyEnd;
    const samples = this.recall(this.speechFrom, this.historyEnd);
    if (samples.length < 0.5 * ASR_RATE) return;
    const stream = this.recognizer.createStream();
    stream.acceptWaveform({ samples, sampleRate: ASR_RATE });
    this.recognizer.decode(stream);
    const text = cleanText(this.recognizer.getResult(stream).text ?? '', this.lang);
    if (text && text !== this.lastPartial) {
      this.lastPartial = text;
      this.opts.onPartial(text);
    }
  }

  /** End of the stream: decodes the sentence still open. */
  flush(): void {
    // Pad with enough silence for the VAD to close the open sentence itself: its flush() drops the
    // last minSilenceDuration of audio, which would cut off the final words.
    const silence = Math.ceil(((this.tuning.minSilenceDuration + 0.1) * ASR_RATE) / VAD_WINDOW) * VAD_WINDOW;
    const tail = new Float32Array(Math.ceil(this.pending.length / VAD_WINDOW) * VAD_WINDOW + silence);
    tail.set(this.pending);
    this.pending = new Float32Array(0);
    for (let off = 0; off < tail.length; off += VAD_WINDOW) this.accept(tail.subarray(off, off + VAD_WINDOW));
    this.vad.flush();
    this.drain();
  }

  /** One window per call: the VAD makes one speech/non-speech decision for everything passed in a call. */
  private accept(window: Float32Array): void {
    const cap = this.history.length;
    for (let i = 0; i < window.length; i++) this.history[(this.historyEnd + i) % cap] = window[i]!;
    this.historyEnd += window.length;
    this.vad.acceptWaveform(window);
  }

  /** Remembered samples [from, to), clipped to what is still in the history. */
  private recall(from: number, to: number): Float32Array {
    const cap = this.history.length;
    from = Math.max(from, this.historyEnd - cap, 0);
    const out = new Float32Array(Math.max(0, to - from));
    for (let i = 0; i < out.length; i++) out[i] = this.history[(from + i) % cap]!;
    return out;
  }

  private drain(): void {
    while (!this.vad.isEmpty()) {
      const segment = this.vad.front(false);
      this.vad.pop();
      this.speechFrom = null;
      this.lastPartial = '';
      this.decode(segment);
    }
  }

  private decode(segment: SherpaSpeechSegment): void {
    if (!segment.samples.length) return;
    const lead = this.recall(segment.start - Math.round(PRE_ROLL_SECONDS * ASR_RATE), segment.start);
    let samples = segment.samples;
    if (lead.length) {
      samples = new Float32Array(lead.length + segment.samples.length);
      samples.set(lead);
      samples.set(segment.samples, lead.length);
    }
    const stream = this.recognizer.createStream();
    stream.acceptWaveform({ samples, sampleRate: ASR_RATE });
    this.recognizer.decode(stream);
    const text = cleanText(this.recognizer.getResult(stream).text ?? '', this.lang);
    if (!text) return;
    const start = (segment.start - lead.length) / ASR_RATE;
    this.opts.onFinal(text, start, start + samples.length / ASR_RATE);
  }
}
