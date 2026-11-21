/**
 * The natural voices (Kokoro-82M, Apache-2.0, in sherpa-onnx's ONNX conversion): one model speaks
 * Chinese, Spanish and English, each with a female and a male voice, offline. Pinned to repository
 * commits with SHA-256s and downloaded like the recognition models (Hugging Face, then hf-mirror).
 *
 * The voices were chosen by ear (listening pack, 2026-11-21) and checked by a round trip through
 * the recognisers (docs/voices.md).
 */
import type { LangBase } from '@core/lang/languages';
import type { ModelFile, ModelFileRole, ModelSpec } from '../local-asr/models';

export type TtsModelId = 'kokoro-v1.0';

const KOKORO_10 = 'csukuangfj/kokoro-multi-lang-v1_0';
const REVISION: Record<string, string> = { [KOKORO_10]: 'f7b96bb6bef5c5da4d3aa4f4e0498fbbf62dc78b' };

function file(repo: string, role: ModelFileRole, name: string, size: number, sha256: string): ModelFile {
  return { role, name, url: `${repo}/resolve/${REVISION[repo]}/${name}`, size, sha256 };
}

/** The Chinese word list (jieba) and number / date / phone rules Kokoro reads Chinese with. */
const zhFront = (repo: string): ModelFile[] => [
  file(repo, 'model', 'date-zh.fst', 59_154, 'eb8aa079ae3cb81d8f4404992f39d61a0cb990947512b5b8d1e54d1f6980e718'),
  file(repo, 'model', 'number-zh.fst', 64_482, '743f402181fcfebf76cc2f0546b71fa26476e626fbe4e460fb7b4c3a7a8bd5bd'),
  file(repo, 'model', 'phone-zh.fst', 88_630, '1ac2b6fa56b1442320c4de7db08353bab8963a2b57f365eebcdd3a2d3562f8d7'),
  file(repo, 'model', 'dict/hmm_model.utf8', 519_739, 'f17790586ac86dd048c8adffed052c4bd2b28ed0682972c1275e59040c0589a7'),
  file(repo, 'model', 'dict/idf.utf8', 5_998_717, 'dbd1e03d72b2263cc8d84a4304ed77677eed9e7deaf43a1a5133bbba9733b535'),
  file(repo, 'model', 'dict/jieba.dict.utf8', 5_071_204, '3043b77068e09c9904f27cad82f12b6ebe9dbdb5aeff3b25e45ab7f9c1122b55'),
  file(repo, 'model', 'dict/pos_dict/char_state_tab.utf8', 327_139, '28b7be1dd7369766a51445af4d42e9a2ba4bf374c13be5bc1ca7721e27271dbb'),
  file(repo, 'model', 'dict/pos_dict/prob_emit.utf8', 1_687_686, 'c33c4cb7edf3b3a5947df7209b6e9f267eae1f21335d9e2bd2521ea07105457a'),
  file(repo, 'model', 'dict/pos_dict/prob_start.utf8', 4_347, '13623ea0e9300bdb597cb2da28770b7b385d6c0098d66e516083fb01b6bd5d96'),
  file(repo, 'model', 'dict/pos_dict/prob_trans.utf8', 124_159, 'f22363e2307408293d180c6f9f6b5cb75879d52f722f7764fa2d3d0ae2400236'),
  file(repo, 'model', 'dict/stop_words.utf8', 8_974, 'b788b8a939d2e2fe079abd579ea98f12f9fb84370bfd0dddd81bb9381f7ab42c'),
  file(repo, 'model', 'dict/user.dict.utf8', 829_194, '5faabcd0c52adf512de77fd7eee3d556da8c98b50f493b47c66a981b3a24959c'),
];

export const TTS_MODELS: Readonly<Record<TtsModelId, ModelSpec>> = {
  'kokoro-v1.0': {
    id: 'kokoro-v1.0',
    label: '自然人声（Kokoro）',
    repo: KOKORO_10,
    files: [
      // The full-precision model: the int8 one is 3.5× slower on ordinary CPUs (measured).
      file(KOKORO_10, 'model', 'model.onnx', 325_560_556, 'b40f62b166ac8164b0627ef48a0b358eda0985e272fb03ef5252e7206305da11'),
      file(KOKORO_10, 'model', 'voices.bin', 28_200_960, '1c5a5b983d3d50d8586d437a51f3faa2da7919ce76a013c081e65671a3447c29'),
      file(KOKORO_10, 'tokens', 'tokens.txt', 687, '6ebb6bb288f20f3ae8d004d3c2ca27697da27c037d75e81a60e2a6a663f95425'),
      file(KOKORO_10, 'model', 'lexicon-us-en.txt', 5_956_885, '7daaab53a181be9885b853a8582bf1838186317e5dadacbcef9c426d6fa0da14'),
      file(KOKORO_10, 'model', 'lexicon-zh.txt', 2_365_182, '902bc2d20ac7c449c5ecbbbb23c89d12119c03ed5b8ed27f114f0260c9e35229'),
      ...zhFront(KOKORO_10),
    ],
  },
};

export interface NeuralVoice {
  lang: LangBase;
  gender: 'female' | 'male';
  model: TtsModelId;
  /** Speaker number in the model's voice table. */
  sid: number;
  name: string;
  /**
   * Normal speed for this voice. The voices speak at different paces: these bring Chinese to about
   * 5.8 characters a second (measured; everyday speech is 5–6) and Spanish to what was chosen by
   * ear (1.1×). Recognised back word for word at these speeds (docs/voices.md).
   */
  speed: number;
}

/** One female and one male voice per language (chosen by ear). */
export const NEURAL_VOICES: readonly NeuralVoice[] = [
  { lang: 'zh', gender: 'female', model: 'kokoro-v1.0', sid: 47, name: '晓晓', speed: 1.27 },
  { lang: 'zh', gender: 'male', model: 'kokoro-v1.0', sid: 50, name: '云希', speed: 1.1 },
  { lang: 'es', gender: 'female', model: 'kokoro-v1.0', sid: 28, name: 'Dora', speed: 1.1 },
  { lang: 'es', gender: 'male', model: 'kokoro-v1.0', sid: 29, name: 'Alex', speed: 1.1 },
  { lang: 'en', gender: 'female', model: 'kokoro-v1.0', sid: 3, name: 'Heart', speed: 1 },
  { lang: 'en', gender: 'male', model: 'kokoro-v1.0', sid: 16, name: 'Michael', speed: 1 },
];

/** Catching up (a backlog of speech) speeds a voice up by at most this much more: faster gets hard to follow. */
export const MAX_CATCH_UP = 1.2;

/** The voice for a language; `voice` is 'female' / 'male' (default female). */
export function neuralVoice(lang: LangBase, voice?: string): NeuralVoice {
  const gender = voice === 'male' ? 'male' : 'female';
  return NEURAL_VOICES.find((v) => v.lang === lang && v.gender === gender) ?? NEURAL_VOICES.find((v) => v.lang === lang)!;
}
