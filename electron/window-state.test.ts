import { describe, expect, it } from 'vitest';
import { DEFAULT_WINDOW, fitWindowState } from './window-state';

const LAPTOP = { x: 0, y: 0, width: 1920, height: 1080 };
const RIGHT = { x: 1920, y: 0, width: 2560, height: 1440 };

describe('fitWindowState', () => {
  it('uses defaults without a saved state', () => {
    expect(fitWindowState(null, [LAPTOP])).toEqual(DEFAULT_WINDOW);
    expect(fitWindowState({ width: 'big' }, [LAPTOP])).toEqual(DEFAULT_WINDOW);
  });

  it('restores a position that is still on a display', () => {
    expect(fitWindowState({ x: 2000, y: 100, width: 1600, height: 1000, maximized: true }, [LAPTOP, RIGHT])).toEqual({
      x: 2000, y: 100, width: 1600, height: 1000, maximized: true,
    });
  });

  it('drops the position when that display is gone, and clamps the size', () => {
    expect(fitWindowState({ x: 2000, y: 100, width: 2400, height: 1400 }, [LAPTOP])).toEqual({ width: 1920, height: 1080, maximized: false });
  });

  it('drops a position whose title bar is off screen', () => {
    expect(fitWindowState({ x: 100, y: -300, width: 1000, height: 800 }, [LAPTOP])).toEqual({ width: 1000, height: 800, maximized: false });
    expect(fitWindowState({ x: 1900, y: 100, width: 1000, height: 800 }, [LAPTOP])).toEqual({ width: 1000, height: 800, maximized: false });
  });

  it('enforces the minimum size', () => {
    expect(fitWindowState({ width: 100, height: 100 }, [LAPTOP])).toMatchObject({ width: 720, height: 480 });
  });
});
