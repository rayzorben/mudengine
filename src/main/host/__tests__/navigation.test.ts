import { describe, expect, it } from 'vitest';

import { staysOnClient } from '../navigation';

/*
 * A desktop window carries the preload's bridge into whatever page it shows,
 * so a page from anywhere else would hold the whole of `IpcApi`. A link
 * dragged onto the window, or a file dropped on it, navigates it by default.
 */
describe('a desktop window navigating', () => {
  const built = 'file:///opt/mudengine/out/renderer/index.html';
  const dev = 'http://localhost:5173/';

  it('stays on the built page, a hash or query on it included', () => {
    expect(staysOnClient(built, built)).toBe(true);
    expect(staysOnClient(built, `${built}#settings`)).toBe(true);
    expect(staysOnClient(built, `${built}?tab=2`)).toBe(true);
  });

  it('stays on the dev server it was loaded from', () => {
    expect(staysOnClient(dev, 'http://localhost:5173/')).toBe(true);
    expect(staysOnClient(dev, 'http://localhost:5173/index.html?t=1')).toBe(true);
  });

  it('refuses a web page, a dropped file and another scheme', () => {
    expect(staysOnClient(built, 'https://example.com/')).toBe(false);
    expect(staysOnClient(built, 'file:///home/someone/Downloads/page.html')).toBe(false);
    expect(staysOnClient(built, 'file:///opt/mudengine/out/renderer/other.html')).toBe(false);
    expect(staysOnClient(dev, 'http://localhost:5174/')).toBe(false);
    expect(staysOnClient(dev, 'https://localhost:5173/')).toBe(false);
    expect(staysOnClient(built, 'javascript:alert(1)')).toBe(false);
    expect(staysOnClient(built, 'not a url')).toBe(false);
    expect(staysOnClient('', built)).toBe(false);
  });
});
