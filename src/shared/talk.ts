/**
 * Which channel a line of chat goes out on.
 *
 * The Talk card's composer sends **verbatim** — the realm's own vocabulary is
 * the vocabulary, and a client that rewrote it would be a second thing to keep
 * in step with a command table it does not own. That is right and it is also
 * the whole ergonomic problem: every line has to start with `gos`, and a
 * conversation is not one line. Nobody types `gos` forty times.
 *
 * So the composer carries a channel, and this decides what a typed line means
 * next to it:
 *
 * - **Type a channel word and it switches**, and the line goes as typed.
 *   `br yo` broadcasts, and the picker moves to broadcast, so the next line
 *   goes there too without being told again. That is the behaviour asked for:
 *   *"it will continue to send to that channel until and unless they change the
 *   dropdown or type `auc`, `gos`, `br`, `gb`."*
 * - **Type anything else and it is prefixed** with the channel showing.
 *
 * The words are not a list written here. They come from the server's own
 * command table (`./commands.ts`, extracted from `Commands.cs`), so `gossi`,
 * `broadca` and `gb` are recognised for the same reason the server recognises
 * them, and a derivative that accepts different spellings is answered by
 * changing the table rather than this.
 *
 * ## Not every channel is a command word
 *
 * Four of them are punctuation, and none of them is in `Commands.cs` at all —
 * which is why this module used to prefix all four with `gos` and gossip the
 * sigil. Captured live 2026-08-27:
 *
 * ```
 * [HP=101/KAI=5]:.hi
 * You say "hi"
 * [HP=101/KAI=5]:"hi
 * You yell "hi"
 * [HP=101/KAI=5]:>soul hi
 * [HP=101/KAI=5]:--- Message Directed to Soul ---
 * [HP=101/KAI=5]:/soul hi
 * --- Telepath Sent to Soul ---
 * ```
 *
 * `.` and `"` take the message immediately, with no space, and address nobody:
 * they are ordinary picker entries. `/` and `>` take **a name first**, so they
 * are a prefix *plus somebody to pick* — which is why they are not in the
 * picker's fixed list and are reached by typing the address instead. Once
 * typed, the picker holds `/Soul` and the next line goes there without the
 * address being retyped, which is the same bargain `br` already makes.
 *
 * Dependency-free, and pure: the composer is a renderer surface and the
 * decision is where the tests are.
 */
import { commandOf, type CommandName } from './commands';

/** What every channel has: what the realm knows it by, and a name to read. */
interface Named {
  /** What the realm addresses it by, and what a stored choice names. */
  word: string;
  /** What the picker calls it. */
  label: string;
}

/** A channel the realm gives a command word. The message follows a space. */
export interface TalkCommandChannel extends Named {
  kind: 'command';
  /** The `CommandName` any accepted spelling of it resolves to. */
  command: CommandName;
}

/**
 * A channel the realm gives a sigil. The message follows it immediately.
 *
 * `.hi` and `"hi`, not `. hi` — captured, and the space would go out as part
 * of what is said.
 */
export interface TalkSigilChannel extends Named {
  kind: 'sigil';
}

/**
 * A channel addressed to one person: the sigil, their name, then the message.
 *
 * Built from what was typed rather than listed, because the name is the half
 * that cannot be shipped. The name is kept in the spelling it was typed in —
 * the server resolves and capitalises it in its own receipt, and a client that
 * guessed the capitalisation would be guessing at somebody's name.
 */
export interface TalkAddressedChannel extends Named {
  kind: 'addressed';
}

/** A channel the composer can be pointed at. */
export type TalkChannel = TalkCommandChannel | TalkSigilChannel | TalkAddressedChannel;

/**
 * The channels a line can simply be prefixed onto.
 *
 * `say` and `yell` are here under their sigils, which are the only names the
 * realm has for them: there is **no `say` command and no `yell` command** in
 * `Commands.cs`, and `You say "..."` is also what the server does with a
 * command it does not recognise. The sigil is not a guess at one — it is what
 * the wire answered on 2026-08-27.
 *
 * Telepath and direct are deliberately absent: they address somebody, so an
 * entry for either would need a second picker beside it, which is a control
 * that does not fit the row. They are reached by typing the address, and the
 * picker holds the one that was typed for as long as the conversation lasts.
 */
export const TALK_CHANNELS: readonly TalkChannel[] = [
  { kind: 'command', word: 'gos', label: 'gossip', command: 'Gossip' },
  { kind: 'command', word: 'br', label: 'broadcast', command: 'Broadcast' },
  { kind: 'command', word: 'gb', label: 'gang', command: 'Broadgang' },
  { kind: 'command', word: 'auc', label: 'auction', command: 'Auction' },
  { kind: 'sigil', word: '.', label: 'say' },
  { kind: 'sigil', word: '"', label: 'yell' }
];

/**
 * The realm's emotes, exactly as `actions` lists them on the test realm
 * (captured 2026-08-26). An action typed into the Talk box is sent as itself.
 */
export const ACTIONS: ReadonlySet<string> = new Set(
  'bearhug bleed blink blush bow burp cackle caress cheer chuckle clap comfort cough cuff curtsy dance egrin elaugh embrace flex frown gasp giggle girn glare greet grin groan growl grumble handshake highfive howl hug hum jump kiss laugh moan nod nudge pinch pout shake shrug sigh slap smack smile smirk smooch sneeze snicker sniff sob spit squeeze tease tickle wave whimper whistle wink yawn'.split(
    ' '
  )
);

/** The channel a stored preference names, or gossip. */
export function talkChannel(word: string | null | undefined): TalkChannel {
  return TALK_CHANNELS.find((channel) => channel.word === word) ?? TALK_CHANNELS[0]!;
}

/** The channel that speaks to one person: `/Soul`, `>Soul`. */
export function addressedTo(sigil: string, name: string): TalkAddressedChannel {
  return { kind: 'addressed', word: `${sigil}${name}`, label: `${sigil}${name}` };
}

/**
 * What goes in front of a message on a channel.
 *
 * A sigil takes the message immediately; everything else takes a space. This
 * is the one place that difference is spelled, because a space put in the
 * wrong one of the two is silent — `. hi` says something with a leading space
 * and `gosHi` is not a command.
 */
export function prefixOf(channel: TalkChannel): string {
  return channel.kind === 'sigil' ? channel.word : `${channel.word} `;
}

export interface Said {
  /**
   * What to send, verbatim, or `null` where only the picker moves.
   *
   * `/Soul` on its own is somebody to talk *to* and nothing to say to them.
   * Sending it earns `You have to telepath something!` and spends from the
   * command budget walking and fighting spend from; moving the picker is what
   * was actually asked for.
   */
  command: string | null;
  /** The channel the composer should be showing afterwards. */
  channel: TalkChannel;
}

/**
 * What a typed line means on a given channel, or `null` for nothing at all.
 *
 * A line whose first word is a channel switches to it and is sent unchanged —
 * including the word, because the server needs it. Everything else is prefixed.
 */
export function compose(typed: string, showing: TalkChannel): Said | null {
  const line = typed.trim();
  if (line.length === 0) return null;

  /*
   * `-hi` and `- hi` broadcast: the one-character shortcut for the channel a
   * person reaches for most, and the picker follows it.
   */
  const dashed = /^-\s*(.*)$/.exec(line);
  if (dashed) {
    const rest = (dashed[1] ?? '').trim();
    return rest.length > 0 ? { command: `br ${rest}`, channel: talkChannel('br') } : null;
  }

  /*
   * The room and the rooms around it. Ahead of the command table because a
   * sigil is not a word and `commandOf` would never claim it — but also ahead
   * of the prefixing below, which is what used to gossip `.hi` as the literal
   * text `gos .hi`.
   */
  const spoken = /^([."])\s*(.*)$/.exec(line);
  if (spoken) {
    const channel = talkChannel(spoken[1]!);
    const rest = spoken[2]!.trim();
    return rest.length > 0 ? { command: `${channel.word}${rest}`, channel } : null;
  }

  /*
   * `/Soul hi` telepaths and `>Soul hi` says it to one person in the room. The
   * name is required — a bare `/` addresses nobody and is prefixed like any
   * other text — and a name with nothing after it points the picker without
   * sending anything.
   */
  const address = /^([/>])\s*([A-Za-z][\w'-]*)\s*(.*)$/.exec(line);
  if (address) {
    const channel = addressedTo(address[1]!, address[2]!);
    const rest = address[3]!.trim();
    return { command: rest.length > 0 ? `${channel.word} ${rest}` : null, channel };
  }

  const named = commandOf(line);
  const switched = TALK_CHANNELS.find(
    (channel) => channel.kind === 'command' && channel.command === named
  );
  if (switched) return { command: line, channel: switched };

  /*
   * `join 1234` is the realm's way onto a broadcast channel; once joined, the
   * next line belongs there, so the picker follows it.
   */
  if (named === 'Join' && /^\S+\s+\d+$/.test(line)) {
    return { command: line, channel: talkChannel('br') };
  }
  /*
   * An action — `dance`, `spit Rend` — is not a message and goes out verbatim,
   * on no channel: prefixed with `gos` it would be *said* rather than done.
   * Only the realm's own list qualifies (`ACTIONS`, captured from `actions`),
   * never any command: `who is around` typed into the Talk box is a question
   * for the channel, not a `who`.
   */
  const first = line.split(/\s+/)[0]?.toLowerCase() ?? '';
  if (ACTIONS.has(first)) return { command: line, channel: showing };

  return { command: `${prefixOf(showing)}${line}`, channel: showing };
}

/* ------------------------------------------------------ how a line is drawn */

/**
 * How the Talk card writes the time beside a line.
 *
 * **The time is always recorded**, whatever this says: `Block.at` is stamped by
 * the classifier and `TalkLog` writes the whole block, so the conversation log
 * on disk carries it for every line whether or not the card draws it. This is
 * only about the card, which is why it is a card setting rather than an option
 * in the character's own file.
 *
 * A closed union with a formatter beside it, in the shape this codebase keeps
 * them: the settings popup offers exactly these and the card renders exactly
 * these, so a stored value the formatter cannot read is impossible rather than
 * merely unlikely.
 *
 * The dropdown shows each option **as itself** — the current time formatted
 * that way — rather than a translated name for it. A row reading
 * `8/20/2026 7:35PM` says everything a label could and is right in every
 * language, and it is the same reasoning that keeps a theme's own name out of
 * the dictionary.
 */
export const TALK_STAMPS = [
  'date-time-12',
  'date-time-24',
  'time-12',
  'time-24',
  'time-24-seconds'
] as const;

export type TalkStamp = (typeof TALK_STAMPS)[number];

/** The shipped answer: the shape the request asked for, `8/20/2026 7:35PM`. */
export const DEFAULT_TALK_STAMP: TalkStamp = 'date-time-12';

/** Whether a value out of a store is a format this build can draw. */
export function isTalkStamp(value: unknown): value is TalkStamp {
  return typeof value === 'string' && (TALK_STAMPS as readonly string[]).includes(value);
}

const pad = (value: number): string => String(value).padStart(2, '0');

/**
 * One moment, in the format asked for. Local time, and pure.
 *
 * Written out rather than handed to `Intl.DateTimeFormat`, for two reasons.
 * The formats are a **closed union this client chose** — a player picking
 * `19:35` wants that on every machine, not whatever their locale's short time
 * happens to be — and `Intl`'s output varies by ICU build, which would make
 * the card's appearance depend on which Electron was packaged. The one thing
 * that stays the machine's is the *zone*: a conversation happened at the time
 * the person reading it was sitting there.
 */
export function formatTalkStamp(at: number, format: TalkStamp): string {
  const when = new Date(at);
  const date24 = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
  const date12 = `${when.getMonth() + 1}/${when.getDate()}/${when.getFullYear()}`;
  const hours = when.getHours();
  const minutes = pad(when.getMinutes());
  // 12-hour clock: midnight and noon are 12, never 0, which is the one case a
  // modulo alone gets wrong.
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  const suffix = hours < 12 ? 'AM' : 'PM';
  const clock12 = `${hour12}:${minutes}${suffix}`;
  const clock24 = `${pad(hours)}:${minutes}`;

  switch (format) {
    case 'date-time-12':
      return `${date12} ${clock12}`;
    case 'date-time-24':
      return `${date24} ${clock24}`;
    case 'time-12':
      return clock12;
    case 'time-24':
      return clock24;
    case 'time-24-seconds':
      return `${clock24}:${pad(when.getSeconds())}`;
  }
}

/**
 * How a line's parts are arranged.
 *
 * - `original` — the realm's own sentence, as it was printed. The console
 *   carries the same words, so the card and the game agree; it is the default
 *   because it is the one shape that invents nothing.
 * - `condensed` — channel, speaker, message, in that order and no more.
 * - `condensed-aligned` — the same three, in columns that line up down the
 *   card. The colour coding is untouched: the columns are a layout, not a
 *   second vocabulary.
 *
 * The alignment is done by the browser, in one grid with `subgrid` rows — no
 * padding to a character count and no measured pixel constant, which the card
 * could not hold anyway (it is resizable, floatable, and the chrome font is
 * whatever the options file says).
 */
export const TALK_LAYOUTS = ['original', 'condensed', 'condensed-aligned'] as const;

export type TalkLayout = (typeof TALK_LAYOUTS)[number];

/** What a line looks like until somebody says otherwise. */
export const DEFAULT_TALK_LAYOUT: TalkLayout = 'original';

/** Whether a value out of a store is a layout this build can draw. */
export function isTalkLayout(value: unknown): value is TalkLayout {
  return typeof value === 'string' && (TALK_LAYOUTS as readonly string[]).includes(value);
}
