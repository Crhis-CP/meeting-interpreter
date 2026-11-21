import type { Secrets } from '@core/config/schema';
import { consoleLogger, createBrowserContext } from './browser-context';
import { buildProviders } from './engine-providers';
import { DESKTOP_DOWNLOAD, type StoredData } from './shared';

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

/** A segmented control made of real radio buttons: one radiogroup named `label`. */
export function seg<T extends string>(label: string, options: readonly (readonly [T, string])[], value: T, onchange: (v: T) => void): HTMLDivElement {
  const name = `seg-${label}`;
  return h('div', { class: 'seg', role: 'radiogroup', 'aria-label': label },
    ...options.map(([v, text]) =>
      h('label', {}, h('input', { type: 'radio', name, value: v, checked: v === value, onchange: () => onchange(v) }), h('span', {}, text)),
    ),
  );
}

/** A labelled key field: name, “saved” badge, where to get one, and a save button (Enter saves too). */
export function keyField(name: keyof Secrets, label: string, saved: boolean, link: string | undefined, save: (value: string) => unknown): HTMLFormElement {
  const id = `key-${name}`;
  const input = h('input', { id, type: 'password', autocomplete: 'off' });
  return h('form', {
    class: 'stack',
    onsubmit: (e: Event) => {
      e.preventDefault();
      void save(input.value.trim());
    },
  },
    h('div', { class: 'row' },
      h('label', { htmlFor: id, id: `${id}-label` }, h('b', {}, label)),
      saved ? h('span', { class: 'badge' }, '已保存') : '',
      h('span', { class: 'grow' }),
      link ? h('a', { href: link, target: '_blank', class: 'btn sm primary', 'aria-describedby': `${id}-label` }, '去获取 ↗') : '',
    ),
    h('div', { class: 'row' }, input, h('button', { class: 'btn', type: 'submit' }, '保存')),
  );
}

/** Shown when the free tier needs the desktop app and it is not running. */
export const desktopMissing = () =>
  h('div', { class: 'callout warn', role: 'status' }, '免费方案需要电脑版正在运行（识别和语音由它提供），现在没有检测到。打开电脑版后会自动连上。', ' ', h('a', { href: DESKTOP_DOWNLOAD, target: '_blank' }, '下载电脑版 ↗'));

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
