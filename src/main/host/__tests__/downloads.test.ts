import { describe, expect, it } from 'vitest';

import { Downloads } from '../web/downloads';

const tokenOf = (link: string): string => link.split('/')[2] ?? '';

describe('Downloads', () => {
  it('gives a file once, under its own name', () => {
    const downloads = new Downloads();
    const link = downloads.offer(1, '/home/logs/debug-a.txt');
    expect(link.endsWith('/debug-a.txt')).toBe(true);
    expect(downloads.take(tokenOf(link))).toBe('/home/logs/debug-a.txt');
    expect(downloads.take(tokenOf(link))).toBeNull();
  });

  it('drops what a closed tab never fetched, and keeps the other tabs', () => {
    const downloads = new Downloads();
    const gone = downloads.offer(1, '/home/exports/a.tar.gz');
    const kept = downloads.offer(2, '/home/exports/b.tar.gz');
    downloads.dropTab(1);
    expect(downloads.take(tokenOf(gone))).toBeNull();
    expect(downloads.take(tokenOf(kept))).toBe('/home/exports/b.tar.gz');
  });
});
