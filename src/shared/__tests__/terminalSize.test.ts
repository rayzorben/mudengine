import { describe, expect, it } from 'vitest';

import { asTerminalSize } from '../types';

describe('a terminal size crossing the bridge', () => {
  it('reads what the window measured', () => {
    expect(asTerminalSize({ cols: 80, rows: 24 })).toEqual({ cols: 80, rows: 24 });
    expect(asTerminalSize({ cols: 255, rows: 1, extra: true })).toEqual({ cols: 255, rows: 1 });
  });

  it('refuses a size that is missing, not whole, or not positive', () => {
    expect(asTerminalSize(null)).toBeNull();
    expect(asTerminalSize(undefined)).toBeNull();
    expect(asTerminalSize('80x24')).toBeNull();
    expect(asTerminalSize({ cols: '80', rows: 24 })).toBeNull();
    expect(asTerminalSize({ cols: 80 })).toBeNull();
    expect(asTerminalSize({ cols: 80.5, rows: 24 })).toBeNull();
    expect(asTerminalSize({ cols: Number.NaN, rows: 24 })).toBeNull();
    expect(asTerminalSize({ cols: 0, rows: 24 })).toBeNull();
    expect(asTerminalSize({ cols: 80, rows: -1 })).toBeNull();
  });
});
