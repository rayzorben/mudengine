/**
 * Files a tab has been handed to download: the debug report, a character
 * export. Main writes each one where it always does (`logs/`, `exports/`);
 * the tab is given a link that fetches it once into the browser's own
 * downloads, since the file is on the client's disk and the viewer is on
 * another machine.
 *
 * A link is good for one fetch and for as long as its tab is open, so what
 * is held is only what a live tab has not fetched yet. The token is random:
 * the route sits behind the password, and the token keeps one signed-in tab
 * from naming a file it was never offered.
 */
import { randomBytes } from 'node:crypto';
import path from 'node:path';

interface Offer {
  readonly tab: number;
  readonly file: string;
}

export class Downloads {
  private readonly offers = new Map<string, Offer>();

  /** The path the tab fetches `file` from, ending in the file's own name. */
  offer(tab: number, file: string): string {
    const token = randomBytes(16).toString('hex');
    this.offers.set(token, { tab, file });
    return `/download/${token}/${encodeURIComponent(path.basename(file))}`;
  }

  /** The file behind a token, given once. Null for one never offered or already taken. */
  take(token: string): string | null {
    const offer = this.offers.get(token);
    if (offer === undefined) return null;
    this.offers.delete(token);
    return offer.file;
  }

  /** A tab has closed: what it never fetched is no longer offered. */
  dropTab(tab: number): void {
    for (const [token, offer] of this.offers) {
      if (offer.tab === tab) this.offers.delete(token);
    }
  }
}
