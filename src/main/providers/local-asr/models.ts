import { baseOf, type LangBase } from '@core/lang/languages';
import type { LangCode } from '@core/types';

/**
 * Models for the free offline recogniser (sherpa-onnx, Silero VAD + offline recognisers), downloaded
 * on first use into `<modelsDir>/<id>/<file>`.
 *
 * Repositories, file names and sizes were checked against the Hugging Face API on 2026-11-20.
 * Every file is pinned to a repository commit and its SHA-256 (from Hugging Face's LFS records,
 * or computed for small text files), and checked before use — so the mirror hf-mirror.com, which
 * serves the same paths, can be used safely too.
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
  /** SHA-256 of the file: a download that does not match is thrown away. */
  sha256?: string;
}

export interface ModelSpec {
  id: string;
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

/** The repository commit each model is pinned to. */
const REVISION: Record<string, string> = {
  [VAD_REPO]: 'fba88cd2e921609e7675c3aaf51e0b9b295da4bc',
  [SENSEVOICE_REPO]: '2365baeacb507f821a0c8120fcee3d484dba7a07',
  [WHISPER_BASE_REPO]: 'bb53ee204431c90d314c1cc08d28d23e5b7927cc',
  [WHISPER_SMALL_REPO]: '8f3c18b358db4d1f2fc1eae49d75cd20989e4309',
};

function file(repo: string, role: ModelFileRole, name: string, size: number, sha256: string): ModelFile {
  return { role, name, url: `${repo}/resolve/${REVISION[repo]}/${name}`, size, sha256 };
}

export const MODELS: Readonly<Record<ModelId, ModelSpec>> = {
  'silero-vad': {
    id: 'silero-vad',
    label: '语音活动检测（Silero VAD）',
    repo: VAD_REPO,
    files: [file(VAD_REPO, 'vad', 'silero_vad.onnx', 1_807_522, 'a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28')],
  },
  sensevoice: {
    id: 'sensevoice',
    label: '中文识别（SenseVoice 小模型）',
    repo: SENSEVOICE_REPO,
    files: [file(SENSEVOICE_REPO, 'model', 'model.int8.onnx', 239_233_841, 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51'),
      file(SENSEVOICE_REPO, 'tokens', 'tokens.txt', 315_894, 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc'),
    ],
  },
  'whisper-base': {
    id: 'whisper-base',
    label: '西语 / 英语识别（Whisper base，较快）',
    repo: WHISPER_BASE_REPO,
    files: [
      file(WHISPER_BASE_REPO, 'encoder', 'base-encoder.int8.onnx', 29_120_534, '0b8fb1304b6109976038efff5ace81720e00386f3ff6b54ee8c75291ca0a1e11'),
      file(WHISPER_BASE_REPO, 'decoder', 'base-decoder.int8.onnx', 130_672_026, '9759d217388a01b3a4c7c15533201067b48ae819c4daafc8624e64b9409dc02d'),
      file(WHISPER_BASE_REPO, 'tokens', 'base-tokens.txt', 816_730, 'b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126'),
    ],
  },
  'whisper-small': {
    id: 'whisper-small',
    label: '西语 / 英语识别（Whisper small，更准）',
    repo: WHISPER_SMALL_REPO,
    files: [
      file(WHISPER_SMALL_REPO, 'encoder', 'small-encoder.int8.onnx', 112_442_483, '4cbe7b22fa9026b843b60a68640c747de05bafb1a11b57edc0e66c232d9f33a9'),
      file(WHISPER_SMALL_REPO, 'decoder', 'small-decoder.int8.onnx', 262_226_114, 'acad50b5c782696e91b55914cc5ab4f756f1532f76e22aa6fc615f39fb69a8ee'),
      file(WHISPER_SMALL_REPO, 'tokens', 'small-tokens.txt', 816_730, 'b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126'),
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
