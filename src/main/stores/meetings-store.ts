import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { MeetingSummary } from '../../core/session/summary';
import { Transcript } from '../../core/session/transcript';
import type { MeetingMeta, TranscriptSegment } from '../../core/types';
import type { MeetingDetail, MeetingListItem, StoredReview } from '../../shared/ipc';
import { readJson, writeJson } from './json-file';

/** Meeting folders under the records directory. */
export class MeetingsStore {
  constructor(private readonly root: () => string) {}

  private folderOf(id: string): string {
    const root = resolve(this.root());
    const folder = resolve(root, id);
    // Never step outside the records directory (ids come from the renderer).
    if (!folder.startsWith(root + sep) || id.includes('..')) throw new Error('无效的会议 ID');
    return folder;
  }

  list(): MeetingListItem[] {
    const root = this.root();
    if (!existsSync(root)) return [];
    const items: MeetingListItem[] = [];
    for (const name of readdirSync(root)) {
      const folder = join(root, name);
      const metaPath = join(folder, 'meeting.json');
      if (!existsSync(metaPath)) continue;
      const meta = readJson<MeetingMeta | null>(metaPath, null);
      if (!meta) continue;
      const tPath = join(folder, 'transcript.jsonl');
      let segments = 0;
      if (existsSync(tPath)) segments = Transcript.fromJsonl(readFileSync(tPath, 'utf8')).size;
      items.push({
        id: name,
        title: meta.title,
        startedAt: meta.startedAt,
        endedAt: meta.endedAt,
        mode: meta.mode ?? 'meeting',
        segments,
        hasSummary: existsSync(join(folder, 'summary.json')),
        hasAudio: !!(meta.files?.mix || meta.files?.mic),
        hasScreen: !!meta.files?.screen,
        folder,
      });
    }
    return items.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  get(id: string): MeetingDetail | null {
    const folder = this.folderOf(id);
    const meta = readJson<MeetingMeta | null>(join(folder, 'meeting.json'), null);
    if (!meta) return null;
    const tPath = join(folder, 'transcript.jsonl');
    const segments = existsSync(tPath) ? Transcript.fromJsonl(readFileSync(tPath, 'utf8')).list() : [];
    const summary = readJson<MeetingSummary | null>(join(folder, 'summary.json'), null);
    const files: MeetingDetail['files'] = [];
    const walk = (dir: string) => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else files.push({ name: n, rel: relative(folder, p).split(sep).join('/'), size: st.size });
      }
    };
    walk(folder);
    const review = readJson<StoredReview | null>(join(folder, 'review.json'), null);
    return { meta: { ...meta, id }, segments, summary, folder, files, review };
  }

  folder(id: string): string {
    return this.folderOf(id);
  }

  filePath(id: string, rel: string): string {
    const folder = this.folderOf(id);
    const p = resolve(folder, rel);
    if (!p.startsWith(folder + sep)) throw new Error('无效的文件路径');
    return p;
  }

  /** Saves a changed sentence (the transcript is append-only: the last line for an id wins). */
  updateSegment(id: string, seg: TranscriptSegment): void {
    const folder = this.folderOf(id);
    appendFileSync(join(folder, 'transcript.jsonl'), `${JSON.stringify(seg)}\n`);
  }

  saveMeta(id: string, meta: MeetingMeta): void {
    writeJson(join(this.folderOf(id), 'meeting.json'), meta);
  }

  saveReview(id: string, review: StoredReview): void {
    writeJson(join(this.folderOf(id), 'review.json'), review);
  }

  rename(id: string, title: string): void {
    const folder = this.folderOf(id);
    const path = join(folder, 'meeting.json');
    const meta = readJson<MeetingMeta | null>(path, null);
    if (!meta) return;
    meta.title = title.trim() || meta.title;
    writeJson(path, meta);
  }
}
