/** Message shapes shared with the content scripts (kept free of heavy imports). */
import type { TranscriptSegment } from '@core/types';

/** Omit that keeps each member of a union. */
export type DOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Messages on the port between the meeting page (bridge) and the offscreen engine. */
export type PageToEngine =
  | { t: 'hello'; top: boolean; micHooked: boolean }
  | { t: 'mic'; pcm: string }
  | { t: 'micHooked' };

export type EngineToPage =
  | { t: 'mode'; active: boolean; passthrough: boolean }
  | { t: 'tts'; id: string; rate: number; pcm: string }
  | { t: 'ttsEnd'; id: string }
  | { t: 'ttsFlush' }
  | { t: 'seg'; seg: TranscriptSegment; mine: boolean }
  | { t: 'partial'; dir: 'out' | 'in'; text: string }
  | { t: 'subtitleStyle'; size: number; showMine: boolean }
  | { t: 'notice'; text: string };

export const PORT_NAME = 'mi-meeting';

/** Messages between the page's main world (microphone hook) and the bridge, via window.postMessage. */
export const PAGE_TAG = '__meetingInterpreter';
export type MainToBridge = { [PAGE_TAG]: 'main'; t: 'mic'; pcm: string } | { [PAGE_TAG]: 'main'; t: 'hooked' };
export type BridgeToMain =
  | { [PAGE_TAG]: 'bridge'; t: 'mode'; active: boolean; passthrough: boolean }
  | { [PAGE_TAG]: 'bridge'; t: 'tts'; id: string; rate: number; pcm: string }
  | { [PAGE_TAG]: 'bridge'; t: 'ttsEnd'; id: string }
  | { [PAGE_TAG]: 'bridge'; t: 'ttsFlush' }
  | { [PAGE_TAG]: 'bridge'; t: 'ping' };
