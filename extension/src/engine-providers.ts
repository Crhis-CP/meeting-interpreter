import type { Secrets } from '@core/config/schema';
import { DesktopBridgeAsr, DesktopBridgeTts } from '@core/bridge/desktop';
import type { GlossaryEntry } from '@core/glossary/types';
import { createProviders, type Providers } from '@core/providers/registry';
import type { ProviderContext } from '@core/providers/types';
import { OfflineMt } from '../../src/browser/offline-mt/engine';
import { toAppSettings, type ExtSettings } from './shared';

let offline: OfflineMt | null = null;
/** Offline translation (Mozilla models), shared by the extension's pages; models live in IndexedDB. */
export function offlineMt(): OfflineMt {
  offline ??= new OfflineMt({
    workerUrl: chrome.runtime.getURL('offline-mt/worker.js'),
    glueUrl: chrome.runtime.getURL('offline-mt/bergamot-translator.js'),
    wasmUrl: chrome.runtime.getURL('offline-mt/bergamot-translator.wasm'),
  });
  return offline;
}

/** The engine's providers; "本机" recognition and voices come from the desktop app (free tier). */
export function buildProviders(settings: ExtSettings, secrets: Secrets, ctx: ProviderContext, glossary: () => GlossaryEntry[]): Providers {
  return createProviders(toAppSettings(settings), secrets, ctx, glossary, {
    localAsr: () => new DesktopBridgeAsr(ctx),
    systemTts: () => new DesktopBridgeTts(ctx),
    offlineMt: { translate: (text, from, to) => offlineMt().translate(text, from, to) },
  });
}

/** Whether the settings use the desktop app. */
export function usesDesktop(s: ExtSettings): boolean {
  return [s.out.asr, s.in.asr].includes('local') || [s.out.tts, s.in.tts].includes('system');
}
