/**
 * The one place a translation direction is assembled (desktop meeting, room, Chrome extension,
 * phone app, CLI), so the rules below are the same everywhere.
 */
import { DirectionPipeline, type PipelineOptions } from './pipeline';

export type DirectionSpec = Omit<PipelineOptions, 'pinyinFuzzy' | 'lowLatency' | 'draft'> & {
  /** The user's interpretation settings (settings.interpretation, or the phone's defaults). */
  interpretation: { pinyinFuzzy: boolean; lowLatency: boolean };
  /** The instant offline translator, when its models are there. */
  draft?: PipelineOptions['draft'];
};

/** Recognisers that load a model locally: slow to reopen, so their session stays open. */
const LOCAL_ASR = new Set(['local', 'desktop']);
/** Translators that are already the instant offline one (or the demo): no draft in front of them. */
const NO_DRAFT = new Set(['offline', 'demo']);

export function createDirection(spec: DirectionSpec): DirectionPipeline {
  const { interpretation, draft, ...rest } = spec;
  return new DirectionPipeline({
    ...rest,
    pinyinFuzzy: interpretation.pinyinFuzzy,
    lowLatency: interpretation.lowLatency,
    draft: draft && !NO_DRAFT.has(spec.translator.id) ? draft : undefined,
    idleCloseMs: spec.idleCloseMs ?? (LOCAL_ASR.has(spec.asr.id) ? 0 : 15000),
  });
}
