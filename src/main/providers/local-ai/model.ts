import type { ModelSpec } from '../local-asr/models';

/**
 * The local AI translation model: Tencent Hy-MT2-1.8B (Apache-2.0), 4-bit GGUF for llama.cpp.
 * Pinned to a repository commit and its SHA-256, like the recognition models.
 */
export const AI_MT_ID = 'hy-mt2-1.8b';
const REPO = 'tencent/Hy-MT2-1.8B-GGUF';
const REV = 'a0c709d9fac510f2c807aa3af52872340dc37a4a';
export const AI_MT_FILE = 'Hy-MT2-1.8B-Q4_K_M.gguf';

export const AI_MT_MODEL: ModelSpec = {
  id: AI_MT_ID,
  label: '本机 AI 翻译（腾讯 Hy-MT2，1.8B）',
  repo: REPO,
  files: [{ role: 'model', name: AI_MT_FILE, url: `${REPO}/resolve/${REV}/${AI_MT_FILE}`, size: 1_133_080_448, sha256: 'dc5f44fcf1fa496ee7ad725982c0c8c553a4de00259b53af84c4b89fb0c06699' }],
};
