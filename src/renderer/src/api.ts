import { useEffect, useRef, useState } from 'react';
import type { AppSettings } from '@core/config/schema';
import { llmPreset } from '@core/providers/openai-compatible';
import type { MeetingState, RendererEvents } from '@shared/ipc';

export const api = window.api;

/**
 * Whether the chosen LLM (minutes, after-meeting learning) can be used: its key is saved, or it
 * needs none. null until known.
 */
export function useLlmReady(s: AppSettings | null): boolean | null {
  const [keys, setKeys] = useState<Record<string, boolean> | null>(null);
  useEffect(() => void api.secrets.status().then(setKeys, () => setKeys({})), [s?.llm.preset]);
  if (!s || !keys) return null;
  const lp = llmPreset(s.llm.preset);
  return !!(lp?.noKey || keys.llm || (lp?.usesDashscopeKey && keys.dashscope));
}

export function useEvent<K extends keyof RendererEvents>(event: K, fn: (p: RendererEvents[K]) => void): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => api.on(event, (p) => ref.current(p)), [event]);
}

export function useSettings(): [AppSettings | null, (patch: object) => Promise<AppSettings>] {
  const [s, setS] = useState<AppSettings | null>(null);
  useEffect(() => {
    void api.settings.get().then(setS);
  }, []);
  useEvent('settings', setS);
  const update = async (patch: object) => {
    const next = await api.settings.set(patch as never);
    setS(next);
    return next;
  };
  return [s, update];
}

export function useMeetingState(): MeetingState | null {
  const [s, setS] = useState<MeetingState | null>(null);
  useEffect(() => {
    void api.meeting.state().then(setS);
  }, []);
  useEvent('meeting-state', setS);
  return s;
}

/** Audio devices with labels (asks for microphone access once so labels are visible). */
export function useDevices(): { inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[]; all: MediaDeviceInfo[]; refresh: () => void } {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const refresh = async () => {
    try {
      let list = await navigator.mediaDevices.enumerateDevices();
      if (list.some((d) => d.kind === 'audioinput' && !d.label)) {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
        s?.getTracks().forEach((t) => t.stop());
        list = await navigator.mediaDevices.enumerateDevices();
      }
      setDevices(list);
    } catch {
      setDevices([]);
    }
  };
  useEffect(() => {
    void refresh();
    navigator.mediaDevices.addEventListener('devicechange', refresh);
    return () => navigator.mediaDevices.removeEventListener('devicechange', refresh);
  }, []);
  const real = (d: MediaDeviceInfo) => d.deviceId !== 'default' && d.deviceId !== 'communications';
  return {
    inputs: devices.filter((d) => d.kind === 'audioinput' && real(d)),
    outputs: devices.filter((d) => d.kind === 'audiooutput' && real(d)),
    /** Including the system's "default" entries (what the default device is right now). */
    all: devices,
    refresh: () => void refresh(),
  };
}

export function errMsg(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

/** Cancelled work (a closed dialog, an aborted download or request) is not an error to show. */
export function isCancellation(err: unknown): boolean {
  const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : '';
  return name === 'AbortError' || /\b(aborted|cancell?ed)\b|已取消/i.test(errMsg(err));
}
