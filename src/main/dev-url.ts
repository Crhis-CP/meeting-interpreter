import { app } from 'electron';

/**
 * The renderer dev server (electron-vite) while developing. Packaged apps ignore the variable, so
 * nothing on the computer can make the installed app load someone else's page.
 */
export function devRendererUrl(): string | undefined {
  if (app.isPackaged) return undefined;
  const u = process.env['ELECTRON_RENDERER_URL'];
  return u && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(u.replace(/\/$/, '')) ? u.replace(/\/$/, '') : undefined;
}
