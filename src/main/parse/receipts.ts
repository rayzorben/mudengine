/**
 * What this character said, bound to the receipt confirming it was said.
 *
 * `--- Telepath Sent to Soul ---`, `--- Message Directed to Soul ---` and
 * `---Page sent to soul---` name the resolved recipient and never the body,
 * so the command that provoked each is the one record of the words. The
 * classifier composes one of these per session. See `mudengine-wire` ›
 * *Talk is talk*.
 */
import type { BlockType } from '../../shared/blocks';
import { echoes } from '../../shared/commands';
import { tuning } from '../app/tuning';

/** One addressed message waiting for its receipt; `name` is lower-cased as typed. */
interface Addressed {
  sigil: '/' | '>';
  name: string;
  body: string;
  /** The whole command as sent, for `refused`. */
  command: string;
}

const ADDRESSED_COMMAND = /^([/>])\s*([A-Za-z][\w'-]*)\s+(\S.*)$/;

export class Receipts {
  /**
   * The addressed messages sent and not yet confirmed (`/soul hi`, `>soul
   * hi`), oldest first. A queue, because the server answers in order and a
   * party joining sends `@health`, `@version` and `@stats` in one burst
   * (todo 03): one slot bound the first receipt to the second send's words and
   * left the rest bare. Bounded by `tuning.parse.maxPendingEchoes`, the same
   * in-flight claim as the echo queue's.
   */
  private addressed: Addressed[] = [];

  /**
   * An outbound command. An addressed message joins the queue; an intervening
   * command leaves it alone, since the receipt for `/soul hi` still means
   * `/soul hi` after an `n` has gone out behind it.
   */
  sent(command: string): void {
    const address = ADDRESSED_COMMAND.exec(command);
    if (!address) return;
    this.addressed.push({
      sigil: address[1] as '/' | '>',
      name: address[2]!.toLowerCase(),
      body: address[3]!.trim(),
      command
    });
    if (this.addressed.length > tuning().parse.maxPendingEchoes) this.addressed.shift();
  }

  /**
   * The server threw away the command it echoed as `echoed` (a fumble), so
   * no receipt is coming for it. Left queued, a refused send to the same
   * person stays oldest and every later receipt to them binds the body one
   * send early: two stunned `@wait`s on 2026-11-01 put Festus's own
   * telepaths to Ire two behind for the rest of the session.
   */
  refused(echoed: string): void {
    const at = this.addressed.findIndex((sent) => echoes(echoed, sent.command));
    if (at >= 0) this.addressed = this.addressed.filter((_, i) => i !== at);
  }

  reset(): void {
    this.addressed = [];
  }

  /**
   * Binds the oldest unconfirmed send on the receipt's own sigil whose name
   * as typed the recipient extends, because the server resolves a target by
   * prefix (`/brack hi` is answered `to Brackle`) and answers in order. Sends
   * on the same sigil queued ahead of that one were refused (`Why are you
   * telepathing to yourself?`, an unknown name) and are dropped. Where
   * nothing matches, `sent` is absent rather than guessed: a wrong body on a
   * receipt is the client misquoting its own player. So where two sends typed
   * under different names both match (`/br hi` refused as `Please be more
   * specific`, then `/brakkle hi`), the receipt stays unbound and both are
   * dropped, so no later receipt binds a body one send early.
   *
   * Deliberately a group of its own (`sent`), never `message`. The player
   * registry's sighting, `Remotes` and the tracker's remote vitals recognise
   * the receipt as this character's own outbound half by `message` being
   * absent; a receipt carrying one would file this character's own words as
   * the recipient speaking.
   */
  bind(type: BlockType, groups: Record<string, string | undefined>): void {
    if (
      type !== 'conversation-telepath' &&
      type !== 'conversation-directed' &&
      type !== 'conversation-page'
    )
      return;
    // An incoming line on the same channel carries a message; a receipt cannot.
    if (groups['message'] !== undefined) return;
    const to = groups['player']?.toLowerCase();
    if (to === undefined) return;
    if (type === 'conversation-page') {
      this.bindPage(to, groups);
      return;
    }
    const sigil = type === 'conversation-telepath' ? '/' : '>';
    // `/p soul hi` is a page (`bindPage`), never a telepath to somebody named P.
    const matches = (sent: Addressed): boolean =>
      sent.sigil === sigil && !(sigil === '/' && sent.name === 'p') && to.startsWith(sent.name);
    const at = this.addressed.findIndex(matches);
    if (at < 0) return;
    const first = this.addressed[at]!;
    const rival = this.addressed.findIndex((sent) => matches(sent) && sent.name !== first.name);
    if (rival < 0) groups['sent'] = first.body;
    const through = rival < 0 ? at : rival;
    this.addressed = this.addressed.filter((sent, i) => i > through || sent.sigil !== sigil);
  }

  /**
   * `---Page sent to soul---`, bound to the `/p soul hi` that sent it. The
   * queue reads that command as a telepath to `p`, so the account is the
   * body's first word and the message the rest.
   */
  private bindPage(to: string, groups: Record<string, string | undefined>): void {
    const at = this.addressed.findIndex((sent) => {
      if (sent.sigil !== '/' || sent.name !== 'p') return false;
      const account = sent.body.split(/\s+/, 1)[0]!.toLowerCase();
      return to.startsWith(account);
    });
    if (at < 0) return;
    const body = this.addressed[at]!.body;
    const said = body.slice(body.search(/\s/) + 1).trim();
    if (said.length > 0 && /\s/.test(body)) groups['sent'] = said;
    this.addressed = this.addressed.filter((_, i) => i !== at);
  }
}
