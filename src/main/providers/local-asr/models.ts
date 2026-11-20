import { baseOf, type LangBase } from '@core/lang/languages';
import type { LangCode } from '@core/types';

/**
 * Models for the free offline recogniser (sherpa-onnx, Silero VAD + offline recognisers), downloaded
 * on first use into `<modelsDir>/<id>/<file>`.
 *
 * Repositories, file names and sizes were checked against the Hugging Face API on 2026-11-20.
 * hf-mirror.com serves the same paths (it redirects to huggingface.co outside mainland China).
 */

export type ModelId = 'silero-vad' | 'sensevoice' | 'whisper-base' | 'whisper-small';
export type WhisperModelId = 'whisper-base' | 'whisper-small';
export type ModelFileRole = 'vad' | 'model' | 'tokens' | 'encoder' | 'decoder';

export interface ModelFile {
  role: ModelFileRole;
  /** File name inside the model's folder. */
  name: string;
  /** Path appended to each base URL. */
  url: string;
  /** Expected size in bytes. Approximate: used to recognise complete files and for progress before the server answers. */
  size: number;
}

export interface ModelSpec {
  id: ModelId;
  /** Name shown in the Chinese UI. */
  label: string;
  /** Hugging Face repository the files come from. */
  repo: string;
  files: ModelFile[];
}

/** Tried in order: Hugging Face first, then the mirror that works from mainland China. */
export const MODEL_BASE_URLS: readonly string[] = ['https://huggingface.co', 'https://hf-mirror.com'];

const VAD_REPO = 'csukuangfj/vad';
const SENSEVOICE_REPO = 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17';
const WHISPER_BASE_REPO = 'csukuangfj/sherpa-onnx-whisper-base';
const WHISPER_SMALL_REPO = 'csukuangfj/sherpa-onnx-whisper-small';

function file(repo: string, role: ModelFileRole, name: string, size: number): ModelFile {
  return { role, name, url: `${repo}/resolve/main/${name}`, size };
}

export const MODELS: Readonly<Record<ModelId, ModelSpec>> = {
  'silero-vad': {
    id: 'silero-vad',
    label: '语音活动检测（Silero VAD）',
    repo: VAD_REPO,
    files: [file(VAD_REPO, 'vad', 'silero_vad.onnx', 1_807_522)],
  },
  sensevoice: {
    id: 'sensevoice',
    label: '中文识别（SenseVoice 小模型）',
    repo: SENSEVOICE_REPO,
    files: [file(SENSEVOICE_REPO, 'model', 'model.int8.onnx', 239_233_841), file(SENSEVOICE_REPO, 'tokens', 'tokens.txt', 315_894)],
  },
  'whisper-base': {
    id: 'whisper-base',
    label: '西语 / 英语识别（Whisper base，较快）',
    repo: WHISPER_BASE_REPO,
    files: [
      file(WHISPER_BASE_REPO, 'encoder', 'base-encoder.int8.onnx', 29_120_534),
      file(WHISPER_BASE_REPO, 'decoder', 'base-decoder.int8.onnx', 130_672_026),
      file(WHISPER_BASE_REPO, 'tokens', 'base-tokens.txt', 816_730),
    ],
  },
  'whisper-small': {
    id: 'whisper-small',
    label: '西语 / 英语识别（Whisper small，更准）',
    repo: WHISPER_SMALL_REPO,
    files: [
      file(WHISPER_SMALL_REPO, 'encoder', 'small-encoder.int8.onnx', 112_442_483),
      file(WHISPER_SMALL_REPO, 'decoder', 'small-decoder.int8.onnx', 262_226_114),
      file(WHISPER_SMALL_REPO, 'tokens', 'small-tokens.txt', 816_730),
    ],
  },
};

export const DEFAULT_WHISPER: WhisperModelId = 'whisper-small';

/** What each language needs. Spanish uses Whisper small; Whisper base is the lighter, faster option. */
export const LANG_MODELS = {
  zh: { recommended: ['silero-vad', 'sensevoice'] },
  es: { recommended: ['silero-vad', 'whisper-small'], light: ['silero-vad', 'whisper-base'] },
  en: { recommended: ['silero-vad', 'whisper-small'], light: ['silero-vad', 'whisper-base'] },
} as const satisfies Record<LangBase, { recommended: readonly ModelId[]; light?: readonly ModelId[] }>;

/** The recogniser model for a language: SenseVoice for Chinese, Whisper for Spanish. */
export function asrModelFor(lang: LangCode, whisper: WhisperModelId = DEFAULT_WHISPER): ModelId {
  return baseOf(lang) === 'zh' ? 'sensevoice' : whisper;
}

/** Every model a language needs (VAD + recogniser). */
export function modelsForLang(lang: LangCode, whisper: WhisperModelId = DEFAULT_WHISPER): ModelId[] {
  return ['silero-vad', asrModelFor(lang, whisper)];
}

/** The file of a model that plays `role` (e.g. the Whisper encoder). */
export function modelFile(id: ModelId, role: ModelFileRole): ModelFile {
  const f = MODELS[id].files.find((x) => x.role === role);
  if (!f) throw new Error(`模型 ${id} 没有 ${role} 文件`);
  return f;
}

/** Total expected download size in bytes. */
export function modelsSize(ids: readonly ModelId[]): number {
  let n = 0;
  for (const id of new Set(ids)) for (const f of MODELS[id].files) n += f.size;
  return n;
}
