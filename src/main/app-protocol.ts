/**
 * The app's own pages are served from mi-app://app/… instead of file://, so the packaged app can
 * switch off Electron's extra file:// privileges (fuse GrantFileProtocolExtraPrivileges). Only
 * files inside the renderer folder can be served; anything else is a 404.
 */
import { extname, resolve, sep } from 'node:path';

export const APP_SCHEME = 'mi-app';
const APP_HOST = 'app';

export type AppPage = 'index' | 'overlay' | 'audio' | 'room';

export const appPageUrl = (page: AppPage): string => `${APP_SCHEME}://${APP_HOST}/${page}.html`;

export function isAppUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === `${APP_SCHEME}:` && u.host === APP_HOST;
  } catch {
    return false;
  }
}

/** The file a mi-app:// URL stands for, or null when it is not inside `rendererDir`. */
export function appFilePath(rendererDir: string, url: string): string | null {
  if (!isAppUrl(url)) return null;
  let rel: string;
  try {
    rel = decodeURIComponent(new URL(url).pathname);
  } catch {
    return null;
  }
  // Decoded slashes / backslashes / dot segments must not climb out, and nothing absolute.
  if (/(^|[\\/])\.\.([\\/]|$)/.test(rel) || /\\/.test(rel) || /^\/{2,}/.test(rel)) return null;
  rel = rel.replace(/^\/+/, '');
  if (!rel) return null;
  const root = resolve(rendererDir);
  const file = resolve(root, rel);
  return file.startsWith(root + sep) ? file : null;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wav': 'audio/wav',
};

export const contentTypeOf = (file: string): string => TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
