import { describe, expect, it } from 'vitest';
import { overlayDefaultBounds, visibleBounds } from '../../src/main/overlay-bounds';

const laptop = { x: 0, y: 25, width: 1440, height: 875 }; // 1440×900 Mac, menu bar on top

describe('subtitle window position', () => {
  it('starts clear of the meeting app toolbar at the bottom of the screen', () => {
    const b = overlayDefaultBounds(laptop);
    const bottomGap = laptop.y + laptop.height - (b.y + b.height);
    expect(bottomGap).toBeGreaterThanOrEqual(140);
    expect(b.x + b.width / 2).toBe(laptop.x + laptop.width / 2);
  });

  it('stays where the user put it, unless that screen is gone', () => {
    const external = { x: 1440, y: 0, width: 1920, height: 1080 };
    const there = { x: 1800, y: 700, width: 900, height: 170 };
    expect(visibleBounds(there, [laptop, external])).toEqual(there);
    expect(visibleBounds(there, [laptop])).toBeNull(); // monitor unplugged: back to the default place
    expect(visibleBounds({ x: 1250, y: 300, width: 900, height: 170 }, [laptop])).not.toBeNull(); // partly off-screen but reachable
    expect(visibleBounds({ x: 1400, y: 300, width: 900, height: 170 }, [laptop])).toBeNull(); // only a sliver left: back to the default place
    expect(visibleBounds({ x: 0, y: 0, width: 50, height: 20 }, [laptop])).toBeNull(); // too small to use
    expect(visibleBounds(null, [laptop])).toBeNull();
  });
});
