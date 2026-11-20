import type { ModelSpec } from '../local-asr/models';

/**
 * The local AI translation models: Tencent Hy-MT2 (Apache-2.0), 4-bit GGUF for llama.cpp, each
 * pinned to a repository commit and its SHA-256 like the recognition models.
 *  - 1.8B: the default; 92 % fully correct on our benchmark, ~1 s a sentence on an ordinary CPU.
 *  - 7B: 96 %, needs ~6 GB of memory; fast on Apple-silicon Macs (GPU), slow on a plain CPU.
 */
export type AiModelId = 'hy-mt2-1.8b' | 'hy-mt2-7b';

function spec(id: AiModelId, label: string, repo: string, rev: string, file: string, size: number, sha256: string): ModelSpec {
  return { id, label, repo, files: [{ role: 'model', name: file, url: `${repo}/resolve/${rev}/${file}`, size, sha256 }] };
}

export const AI_MODELS: Record<AiModelId, ModelSpec> = {
  'hy-mt2-1.8b': spec('hy-mt2-1.8b', '本机 AI 翻译（Hy-MT2 1.8B）', 'tencent/Hy-MT2-1.8B-GGUF', 'a0c709d9fac510f2c807aa3af52872340dc37a4a', 'Hy-MT2-1.8B-Q4_K_M.gguf', 1_133_080_448, 'dc5f44fcf1fa496ee7ad725982c0c8c553a4de00259b53af84c4b89fb0c06699'),
  'hy-mt2-7b': spec('hy-mt2-7b', '本机 AI 翻译（Hy-MT2 7B）', 'tencent/Hy-MT2-7B-GGUF', 'ab8472660ac61fac25f1af43fac2599d52a8a775', 'Hy-MT2-7B-Q4_K_M.gguf', 4_624_648_896, '9f96256500f3fc1ab4d64336b58f52a949a95ad7516b0c229476eef782f9f77b'),
};

export const aiModelFile = (id: AiModelId) => AI_MODELS[id].files[0]!.name;
