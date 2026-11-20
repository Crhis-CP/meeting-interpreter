import type { Secrets } from '@core/config/schema';
import { DesktopBridgeAsr, DesktopBridgeTts } from '@core/bridge/desktop';
import type { GlossaryEntry } from '@core/glossary/types';
import { createProviders, type Providers } from '@core/providers/registry';
import type { ProviderContext } from '@core/providers/types';
import { toAppSettings, type ExtSettings } from './shared';

/** The engine's providers; "本机" recognition and voices come from the desktop app (free tier). */
export function buildProviders(settings: ExtSettings, secrets: Secrets, ctx: ProviderContext, glossary: () => GlossaryEntry[]): Providers {
  return createProviders(toAppSettings(settings), secrets, ctx, glossary, {
    localAsr: () => new DesktopBridgeAsr(ctx),
    systemTts: () => new DesktopBridgeTts(ctx),
  });
}

/** Whether the settings use the desktop app. */
export function usesDesktop(s: ExtSettings): boolean {
  return [s.out.asr, s.in.asr].includes('local') || [s.out.tts, s.in.tts].includes('system');
}
