/** Where the subtitle window goes (pure, so it can be tested without Electron). */

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where the subtitles go the first time: centred, above the bottom of the screen by more than a
 * meeting app's toolbar (Zoom, 腾讯会议, 飞书 keep mute / leave / share there; Teams at the top).
 */
export function overlayDefaultBounds(area: Bounds): Bounds {
  const width = Math.min(1000, Math.round(area.width * 0.7));
  const height = 170;
  return { x: Math.round(area.x + (area.width - width) / 2), y: Math.max(area.y, area.y + area.height - height - 150), width, height };
}

/** The saved position, if enough of it is still on a screen (a monitor may have been unplugged). */
export function visibleBounds(saved: Bounds | null | undefined, areas: Bounds[]): Bounds | null {
  if (!saved || saved.width < 200 || saved.height < 60) return null;
  const onScreen = areas.some((a) => {
    const w = Math.min(saved.x + saved.width, a.x + a.width) - Math.max(saved.x, a.x);
    const h = Math.min(saved.y + saved.height, a.y + a.height) - Math.max(saved.y, a.y);
    return w >= 120 && h >= 50;
  });
  return onScreen ? saved : null;
}
