// Downloads a local AI translation model exactly as the app pins it (repository commit + SHA-256),
// for the real-model tests. Prints the file's path. Skips the download when a verified copy exists.
// Usage: npx tsx --tsconfig tsconfig.node.json scripts/dev/fetch-ai-model.mts <dir> [hy-mt2-1.8b|hy-mt2-7b]
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AI_MODELS, type AiModelId } from '../../src/main/providers/local-ai/model';
import { MODEL_BASE_URLS } from '../../src/main/providers/local-asr/models';

const dir = resolve(process.argv[2] ?? 'models');
const id = (process.argv[3] ?? 'hy-mt2-1.8b') as AiModelId;
const file = AI_MODELS[id]?.files[0];
if (!file) throw new Error(`unknown model ${id}`);
mkdirSync(dir, { recursive: true });
const path = join(dir, file.name);

async function sha256(p: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(p)) h.update(chunk as Buffer);
  return h.digest('hex');
}

if (!(existsSync(path) && statSync(path).size === file.size && (await sha256(path)) === file.sha256)) {
  const part = `${path}.part`;
  const res = await fetch(`${MODEL_BASE_URLS[0]}/${file.url}`);
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(part));
  const got = await sha256(part);
  if (got !== file.sha256) throw new Error(`SHA-256 mismatch: ${got}`);
  renameSync(part, path);
}
console.log(path);
