import { describe, expect, it } from 'vitest';
import { join, resolve, sep } from 'node:path';
import { appFilePath, appPageUrl, contentTypeOf, isAppUrl } from '../../src/main/app-protocol';

const root = resolve('/opt/app/out/renderer');

describe('mi-app:// — the app pages, served only from the renderer folder', () => {
  it('maps page and asset URLs into the renderer folder', () => {
    expect(appPageUrl('index')).toBe('mi-app://app/index.html');
    expect(appFilePath(root, 'mi-app://app/index.html')).toBe(join(root, 'index.html'));
    expect(appFilePath(root, 'mi-app://app/assets/index-abc.js?x=1#y')).toBe(join(root, 'assets', 'index-abc.js'));
    expect(appFilePath(root, 'mi-app://app/offline-mt/bergamot%20translator.wasm')).toBe(join(root, 'offline-mt', 'bergamot translator.wasm'));
  });

  it('never leaves the renderer folder', () => {
    const attacks = [
      'mi-app://app/../../etc/passwd',
      'mi-app://app/%2e%2e/%2e%2e/etc/passwd',
      'mi-app://app/..%2f..%2fetc%2fpasswd',
      'mi-app://app/assets/..%5c..%5c..%5cwindows%5cwin.ini',
      'mi-app://app/%2Fetc%2Fpasswd',
      'mi-app://app//etc/passwd',
      'mi-app://app/%00/x',
    ];
    for (const u of attacks) {
      const p = appFilePath(root, u);
      expect(p === null || p.startsWith(root + sep), `${u} → ${p}`).toBe(true);
    }
    // Encoded slashes / backslashes that would climb out are refused outright.
    expect(appFilePath(root, 'mi-app://app/..%2f..%2fetc%2fpasswd')).toBeNull();
    expect(appFilePath(root, 'mi-app://app/assets/..%5c..%5c..%5cwindows%5cwin.ini')).toBeNull();
    for (const u of ['mi-app://other/index.html', 'mi-media://app/index.html', 'file:///opt/app/out/renderer/index.html', 'mi-app://app/']) expect(appFilePath(root, u), u).toBeNull();
    expect(appFilePath(root, 'mi-app://app/renderer-evil/x.js')).toBe(join(root, 'renderer-evil', 'x.js'));
  });

  it('knows which URLs are the app', () => {
    expect(isAppUrl('mi-app://app/index.html#/history')).toBe(true);
    expect(isAppUrl('mi-app://evil/index.html')).toBe(false);
    expect(isAppUrl('file:///etc/passwd')).toBe(false);
    expect(isAppUrl('https://example.com')).toBe(false);
  });

  it('sends the right content types', () => {
    expect(contentTypeOf('a/index.html')).toBe('text/html; charset=utf-8');
    expect(contentTypeOf('a/x.js')).toBe('text/javascript; charset=utf-8');
    expect(contentTypeOf('a/x.wasm')).toBe('application/wasm');
    expect(contentTypeOf('a/x.unknown')).toBe('application/octet-stream');
  });
});
