/** Which way speech flows. `out`: me → the meeting; `in`: the meeting → me; `room`: an on-site room participant. */
export type Direction = 'out' | 'in';
export type SegmentDir = Direction | 'room';

/** BCP-47 language tag, e.g. `zh-CN`, `es-ES`. */
export type LangCode = string;

export type SegmentStatus = 'translating' | 'done' | 'failed' | 'skipped';

/** One committed unit of speech and its translation. */
export interface TranscriptSegment {
  /** Stable id, e.g. `out-12` or `room-ab12-3`. */
  id: string;
  dir: SegmentDir;
  /** Who spoke: `me`, `them`, or a room participant's display name. */
  speaker: string;
  seq: number;
  /** Seconds since the meeting started. */
  start: number;
  end: number;
  srcLang: LangCode;
  srcText: string;
  dstLang: LangCode;
  dstText: string | null;
  status: SegmentStatus;
  error?: string;
  /** The translation shown is the fast offline draft; the final one is on its way. */
  draft?: boolean;
  /** Glossary corrections applied to the recognised text. */
  edits?: { from: string; to: string }[];
}

export interface PcmChunk {
  samples: Int16Array;
  sampleRate: number;
}

export interface MeetingMeta {
  id: string;
  title: string;
  /** ISO-8601. */
  startedAt: string;
  endedAt?: string;
  selfLang: LangCode;
  remoteLang: LangCode;
  platform?: string;
  mode: 'meeting' | 'room';
  /** Relative file paths inside the meeting folder, by role. */
  files: Record<string, string>;
  /** Providers used, for the record (never keys). */
  providers?: Record<string, string>;
}
