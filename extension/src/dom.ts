import { consoleLogger, createBrowserContext } from './browser-context';
import { buildProviders } from './engine-providers';
import type { StoredData } from './shared';

type Child = Node | string | null | undefined | false;
type Props = Record<string, unknown> & { class?: string; style?: string };

/** Tiny element helper: h('button', { class: 'btn', onclick }, '开始'). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'style') el.setAttribute('style', String(v));
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k in el) (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

/** Why the current settings cannot start (a missing key etc.), or null when they can. */
export function settingsProblem(data: StoredData): string | null {
  try {
    const ctx = createBrowserContext(consoleLogger('check'), async () => undefined);
    const p = buildProviders(data.settings, data.secrets, ctx, () => data.glossary);
    for (const dir of ['out', 'in'] as const) {
      p.asr(dir);
      p.mt(dir);
      p.tts(dir);
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
