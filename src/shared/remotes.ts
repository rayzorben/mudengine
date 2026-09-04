/**
 * The `@` commands other players' clients send to this one, and what may be
 * answered.
 *
 * MegaMUD gave every character a small remote-control vocabulary spoken over
 * the game's own chat channels: `/Soul @health` telepaths a question, and the
 * client on the other end answers `{HP=4434/4434,MA=516/516}` without its
 * player touching the keyboard. Sixty-odd of them are documented in MegaMUD's
 * manual. That manual is **not evidence**: it says what the commands mean and
 * says nothing about the bytes, and this project writes patterns from captures.
 *
 * ## What the captures actually show
 *
 * `captures/` holds 214 sessions of other people's play, and eleven of these
 * commands appear in them — with, between them, exactly **two** reply shapes:
 *
 * ```
 * Sackhunter telepaths:  @health          -> /Sackhunter {HP=600/600}
 * Syntax telepaths: @health               -> Syntax telepaths: {HP=4434/4434,MA=516/516}
 * /ses @do a ooz                          -> Sesub telepaths: {ok}
 * Jek telepaths: {ok}                     (the same, for @do eq crimson feather)
 * Vulcan says (to you) "{ok}"             (the same, on the directed channel)
 * Celyn telepaths: @wait (can't move)
 * Sirkilla says "@kill Gambit"
 * Halifax says "@party stat"
 * Swampfox says "@party go rift"
 * ```
 *
 * So `{HP=…}` and `{ok}` are the whole documented reply vocabulary. Every other
 * command in the manual — `@exp`, `@level`, `@where`, `@wealth`, `@settings`
 * and the rest — has **no captured answer**, and inventing one would put this
 * client's guess on another player's screen in a format their client would then
 * fail to read. Those are listed here as `unread`, with the reason, and are the
 * to-do in `todo-megamud-commands.md`.
 *
 * ## Two things are refused rather than unimplemented
 *
 * `@kill` asks this character to attack a **player**, and `@hangup` asks it to
 * disconnect. Both are refusals the client already makes for itself — auto
 * combat never swings at a person, and an unclean disconnect is how a character
 * dies on this server — and a chat message from somebody else is the last thing
 * that should be able to overrule either. They are answered with a refusal
 * rather than ignored, because a safety feature that silently declines is worse
 * than one never offered.
 *
 * Dependency-free, like everything in `shared/`.
 */

/** Every `@` command MegaMUD's manual names, in the manual's own order. */
import { EXP_RATE_SETTLE_MS, type Stealth } from './character';

export const REMOTE_NAMES = [
  'version',
  'health',
  'exp',
  'level',
  'status',
  'lives',
  'where',
  'path',
  'seen',
  'who',
  'what',
  'wealth',
  'enc',
  'have',
  'home',
  'invite',
  'join',
  'forget',
  'get-all',
  'drop-all',
  'equip-all',
  'deposit-all',
  'do',
  'goto',
  'loop',
  'looponce',
  'roam',
  'stop',
  'rego',
  'attack-last',
  'auto-all',
  'auto-combat',
  'auto-nuke',
  'auto-heal',
  'auto-bless',
  'auto-light',
  'auto-cash',
  'auto-get',
  'auto-sneak',
  'auto-hide',
  'auto-search',
  'settings',
  'reset',
  'divert',
  'hangup',
  'relog',
  'wait',
  'ok',
  'comeback',
  'heal',
  'blind',
  'diseased',
  'held',
  'party',
  'kill',
  'share',
  'panic!',
  /*
   * Not from MegaMUD's manual: mudengine's own peer extension, the one
   * addition to the vocabulary. A character whose blessing (cast by a party
   * member running this client) wears off telepaths `@bless-expired <spell>`
   * back to the caster, whose `Blessings` then recasts on the event instead
   * of waiting out its fallback clock. Sent only when
   * `spells.notifyPartyOnWearOff` is on; acted on only through the same
   * per-player permission gate as every other actionable remote. One
   * spelling, deliberately — an alias would be a second permission switch
   * for the same command.
   */
  'bless-expired'
] as const;

export type RemoteName = (typeof REMOTE_NAMES)[number];

/**
 * How far this client can go with one of them.
 *
 * - `answered` — the reply shape is in a capture, so the command round-trips.
 * - `acted` — it asks for an action and acknowledges nothing, so there is
 *   nothing to guess: the action is the whole of it.
 * - `refused` — understood, and declined on purpose. See the note above.
 * - `unread` — no captured reply, so answering would mean inventing a format
 *   another client has to parse. Recorded, reported, not answered.
 */
export type RemoteSupport = 'answered' | 'acted' | 'refused' | 'unread';

/**
 * The four standing refusals, by id. The sentences themselves are UI copy and
 * live in `locales/ui.en.yaml` under `automation.remotes.refusal.*`; `shared`
 * stays dependency-free, so this file carries only the id and the responder
 * (`Remotes`) looks the sentence up with its own `t`.
 */
export type RemoteRefusal = 'kill' | 'hangup' | 'relog' | 'panic';

/**
 * What can be said about one command is different for each kind of support, so
 * the kinds carry different fields — a spec that could hold a refusal id on an
 * answered command would be a state nothing should be able to represent.
 *
 * - `answered` / `acted` explain themselves by working.
 * - `refused` names which standing refusal answers it.
 * - `because` on `unread` is documentation carried as data — why no capture
 *   lets this client answer yet — asserted non-empty by `remotes.test.ts` so a
 *   command cannot be shrugged off without a written reason.
 */
export type RemoteSpec =
  | { name: RemoteName; support: 'answered' | 'acted' }
  | { name: RemoteName; support: 'refused'; refusal: RemoteRefusal }
  | { name: RemoteName; support: 'unread'; because: string };

/**
 * The table, and the **only** place support is stated.
 *
 * A closed union with its runtime list beside it, in the shape this codebase
 * keeps them: `REMOTE_NAMES` is the union's source and every name in it
 * has a row here, asserted by `src/shared/__tests__/remotes.test.ts`. A command
 * in one and not the other is a command the parser accepts and the responder
 * has nothing to say about.
 */
export const REMOTES: Readonly<Record<RemoteName, RemoteSpec>> = {
  health: {
    name: 'health',
    support: 'answered'
  },
  do: {
    name: 'do',
    support: 'answered'
  },
  join: { name: 'join', support: 'acted' },
  forget: {
    name: 'forget',
    support: 'acted'
  },
  'get-all': {
    name: 'get-all',
    support: 'acted'
  },
  party: {
    name: 'party',
    support: 'acted'
  },
  wait: {
    name: 'wait',
    support: 'acted'
  },
  ok: { name: 'ok', support: 'acted' },

  kill: {
    name: 'kill',
    support: 'refused',
    refusal: 'kill'
  },
  hangup: {
    name: 'hangup',
    support: 'refused',
    refusal: 'hangup'
  },
  relog: {
    name: 'relog',
    support: 'refused',
    refusal: 'relog'
  },
  'panic!': {
    name: 'panic!',
    support: 'refused',
    refusal: 'panic'
  },

  version: { name: 'version', support: 'answered' },
  exp: { name: 'exp', support: 'answered' },
  level: { name: 'level', support: 'answered' },
  status: { name: 'status', support: 'answered' },
  lives: { name: 'lives', support: 'answered' },
  where: { name: 'where', support: 'answered' },
  path: {
    name: 'path',
    support: 'unread',
    because: 'no capture shows the reply format, and a loop here is not a path file'
  },
  seen: {
    name: 'seen',
    support: 'unread',
    because:
      'MegaMUD 2.1 itself answers `{command invalid or not allowed}` (captured 2026-08-29), so ' +
      'there is no reply format to match; the registry knows where somebody was last seen, and ' +
      'what to say about it is a decision'
  },
  who: { name: 'who', support: 'answered' },
  what: { name: 'what', support: 'answered' },
  wealth: { name: 'wealth', support: 'answered' },
  enc: { name: 'enc', support: 'answered' },
  have: { name: 'have', support: 'answered' },
  home: {
    name: 'home',
    support: 'unread',
    because: 'it is an operator command; nothing here can answer it'
  },
  // Both of these read `it waits for the per-player gating this has none of
  // yet` until 2026-08-29. The gate arrived, so the exemption went: an
  // exemption is a claim with a date on it, and neither has anything else
  // left to settle -- each is one command the realm already answers, and
  // neither is answered back because no capture shows a reply for either.
  invite: { name: 'invite', support: 'acted' },
  'drop-all': { name: 'drop-all', support: 'acted' },
  'equip-all': {
    name: 'equip-all',
    support: 'unread',
    because:
      'the slot a listing has never named is not invented here, so "not already equipped" is a ' +
      'question this client cannot answer for every item'
  },
  'deposit-all': {
    name: 'deposit-all',
    support: 'unread',
    because: 'nothing here models a bank, and no capture shows the exchange'
  },
  goto: {
    name: 'goto',
    support: 'unread',
    because:
      'the walk itself is one `WorldGraph.route` away, but an ambiguous room name is refused ' +
      'here rather than guessed, and no capture shows how a refusal is reported back'
  },
  loop: {
    name: 'loop',
    support: 'unread',
    because: 'the same: startable, with no captured way to say the name matched nothing'
  },
  looponce: {
    name: 'looponce',
    support: 'unread',
    because: 'the runner has no one-lap mode, and no capture shows the reply'
  },
  roam: { name: 'roam', support: 'unread', because: 'no such mode' },
  stop: {
    name: 'stop',
    support: 'unread',
    because:
      'stopping a walk is one call, but no capture shows the acknowledgement and `@rego` below ' +
      'has to resume exactly what this stopped'
  },
  rego: {
    name: 'rego',
    support: 'unread',
    because: 'the other half of `@stop`'
  },
  'attack-last': {
    name: 'attack-last',
    support: 'unread',
    because: 'no such setting here'
  },
  'auto-all': {
    name: 'auto-all',
    support: 'unread',
    because: 'the settings do not map one for one, and no capture shows the reply'
  },
  'auto-combat': {
    name: 'auto-combat',
    support: 'unread',
    because: 'the setting exists (`automation.combat`) and no capture shows the reply'
  },
  'auto-nuke': {
    name: 'auto-nuke',
    support: 'unread',
    because: 'no such setting here'
  },
  'auto-heal': {
    name: 'auto-heal',
    support: 'unread',
    because: 'the setting exists (`automation.spells`) and no capture shows the reply'
  },
  'auto-bless': {
    name: 'auto-bless',
    support: 'unread',
    because: 'no such setting here'
  },
  'auto-light': {
    name: 'auto-light',
    support: 'unread',
    because: 'nothing here lights a torch unasked, on purpose'
  },
  'auto-cash': {
    name: 'auto-cash',
    support: 'unread',
    because: 'no such setting here'
  },
  'auto-get': {
    name: 'auto-get',
    support: 'unread',
    because: 'the setting exists (`automation.loot`) and no capture shows the reply'
  },
  'auto-sneak': {
    name: 'auto-sneak',
    support: 'unread',
    because: 'the setting exists (`automation.movement.sneak`) and no capture shows the reply'
  },
  'auto-hide': {
    name: 'auto-hide',
    support: 'unread',
    because: 'no such setting here'
  },
  'auto-search': {
    name: 'auto-search',
    support: 'unread',
    because: 'no such setting here'
  },
  settings: { name: 'settings', support: 'answered' },
  reset: {
    name: 'reset',
    support: 'unread',
    because: 'no capture shows the reply, and what would be reset is not the same set'
  },
  divert: {
    name: 'divert',
    support: 'unread',
    because:
      'nothing here forwards a channel, and what it would forward is a third party’s words — the ' +
      'one command in the table that leaks somebody who is not in the conversation'
  },
  comeback: {
    name: 'comeback',
    support: 'unread',
    because: 'nothing here retraces a walk, and no capture shows the exchange'
  },
  heal: {
    name: 'heal',
    support: 'unread',
    because:
      'auto-heal already casts on a member below a threshold, and a request carries no number — ' +
      'what a request should do that the threshold does not is undecided'
  },
  blind: {
    name: 'blind',
    support: 'unread',
    because: 'nothing here models blindness, and no capture shows a cure'
  },
  diseased: {
    name: 'diseased',
    support: 'unread',
    because: 'nothing here models disease, and no capture shows a cure'
  },
  held: {
    name: 'held',
    support: 'unread',
    because: 'nothing here models being held, and no capture shows a release'
  },
  share: {
    name: 'share',
    support: 'unread',
    because: 'nothing here splits money, and no capture shows the exchange'
  },
  // Acted and not answered, like `@join`: the recast the sender sees land on
  // them is the acknowledgement both clients can already read.
  'bless-expired': { name: 'bless-expired', support: 'acted' }
};

/** One `@` command as it arrived, with whatever followed it. */
export interface RemoteCall {
  name: RemoteName;
  /** Everything after the command word, trimmed, or null when nothing followed. */
  argument: string | null;
  /** The command as spelled, for reporting a refusal in the sender's own words. */
  raw: string;
}

/**
 * Reads a chat message as an `@` command, or `null`.
 *
 * **Anchored at the start.** `Stiffy gossips: wow ... @health` is somebody
 * talking; `@health` on its own is a command. Anchoring is what keeps a client
 * from being driven by a sentence somebody wrote about it.
 *
 * The trailing `(can't move)` on `@wait` in captures/074 is MegaMUD's own
 * annotation and is kept as the argument rather than being matched: it is not
 * part of the vocabulary and a realm's version may word it differently.
 */
export function parseRemoteCall(message: string): RemoteCall | null {
  const match = /^\s*@(?<word>[a-z-]+!?)(?:\s+(?<argument>.*\S))?\s*$/i.exec(message);
  if (!match?.groups) return null;
  const word = match.groups['word']!.toLowerCase();
  const name = REMOTE_NAMES.find((candidate) => candidate === word);
  if (name === undefined) return null;
  const argument = match.groups['argument']?.trim() ?? null;
  return {
    name,
    argument: argument === null || argument.length === 0 ? null : argument,
    raw: word
  };
}

/**
 * What another client said back.
 *
 * Two shapes, both captured, both wrapped in braces so neither can be confused
 * with somebody talking:
 *
 * - `{HP=600/600}` and `{HP=4434/4434,MA=516/516}` — the answer to `@health`.
 *   The mana half is **optional**, for the same reason it is optional in the
 *   status line and the party roster: a warrior has none, and one sample would
 *   have produced a pattern that silently never matched a caster.
 * - `{ok}` — the acknowledgement `@do` and its like return.
 */
export type RemoteReply =
  | {
      kind: 'vitals';
      hp: number;
      hpMax: number;
      mana: number | null;
      manaMax: number | null;
    }
  | { kind: 'ok' };

const VITALS =
  /^\{\s*(?:HP|H)\s*=\s*(?<hp>\d+)\s*\/\s*(?<hpMax>\d+)(?:\s*,\s*(?:MA|KAI|M|K)\s*=\s*(?<mana>\d+)\s*\/\s*(?<manaMax>\d+))?\s*\}$/i;

export function parseRemoteReply(message: string): RemoteReply | null {
  const text = message.trim();
  if (/^\{\s*ok\s*\}$/i.test(text)) return { kind: 'ok' };
  const match = VITALS.exec(text);
  if (!match?.groups) return null;
  const mana = match.groups['mana'];
  const manaMax = match.groups['manaMax'];
  return {
    kind: 'vitals',
    hp: Number(match.groups['hp']),
    hpMax: Number(match.groups['hpMax']),
    mana: mana === undefined ? null : Number(mana),
    manaMax: manaMax === undefined ? null : Number(manaMax)
  };
}

/**
 * This client's own `@health` answer, in the format the captures show.
 *
 * **Nothing is sent without a maximum.** `{HP=600/600}` states a pair, and a
 * client with no stat sheet yet has no maximum to state — `{HP=62/0}` would be
 * a lie in the reassuring direction on somebody else's screen, and `{HP=62}` is
 * a shape no capture shows and no other client parses. Null here, and the
 * caller says out loud that it could not answer.
 */
export function formatVitals(
  hp: number | null,
  hpMax: number | null,
  mana: number | null,
  manaMax: number | null
): string | null {
  if (hp === null || hpMax === null || hpMax <= 0) return null;
  const body = `HP=${hp}/${hpMax}`;
  if (mana === null || manaMax === null || manaMax <= 0) return `{${body}}`;
  return `{${body},MA=${mana}/${manaMax}}`;
}

/*
 * The answers to the questions, in the shapes MegaMUD 2.1 gave when asked
 * (`npm run probe:megamud -- --to Rand`, 2026-08-29, captures/215). Every one
 * is a single telepath in braces. Pure, so the shapes are tested against the
 * capture rather than against a session.
 *
 * Every one returns **null rather than a number it does not have**: a `@lives`
 * before any stat sheet, a `@where` before any room, a `@wealth` before any
 * listing — and the responder then says so locally instead of sending a zero
 * that reads, on somebody else's screen, as a fact.
 */

/** `1,250` — the thousands separator MegaMUD prints (`Needed: 2,150`). */
export function withCommas(value: number): string {
  return Math.trunc(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * `{Made: 0  Needed: 2,150  Rate: ? k/hr  Will level in: ?}` — two spaces
 * between fields, `?` where MegaMUD cannot compute a figure. The captured
 * sample was a character that had made nothing, so `?` is all that is
 * captured for the last two; when this client *can* compute them it prints a
 * rate to one decimal and the wait in hours and minutes — a display on the
 * asker's screen, not a format another client parses.
 *
 * Null before the session has begun: `made` is a running count that starts
 * at zero, and until a first status line has stamped `since` that zero is
 * "nothing counted yet", not "nothing made" — the same zero, and a different
 * fact. A rate that rounds to `0.0` is `?` too, rather than a nothing beside
 * a wait computed from the unrounded figure.
 */
export function formatExp(
  made: number,
  needed: number | null,
  since: number | null,
  now: number
): string | null {
  if (since === null) return null;
  const perHour = ratePerHour(made, since, now);
  const rate = perHour === null ? '?' : `${(perHour / 1000).toFixed(1)}`;
  const wait = perHour === null || needed === null ? '?' : formatHours(needed / perHour);
  const need = needed === null ? '?' : withCommas(needed);
  return `{Made: ${withCommas(made)}  Needed: ${need}  Rate: ${rate} k/hr  Will level in: ${wait}}`;
}

/**
 * Experience per hour, or null while there is nothing to divide or too little
 * time to divide by (`EXP_RATE_SETTLE_MS`, shared with the Vitals card so the
 * two never disagree about whether a rate exists yet), or when the figure
 * would print as `0.0 k/hr`.
 */
function ratePerHour(made: number, since: number, now: number): number | null {
  const elapsed = now - since;
  if (made <= 0 || elapsed < EXP_RATE_SETTLE_MS) return null;
  const perHour = made / (elapsed / 3_600_000);
  return perHour / 1000 < 0.05 ? null : perHour;
}

function formatHours(hours: number): string {
  const whole = Math.floor(hours);
  const minutes = Math.round((hours - whole) * 60);
  return whole > 0 ? `${whole}h ${minutes}m` : `${minutes}m`;
}

/** `{Level: 1  Needed: 2,150  Will level in: ?}`. */
export function formatLevel(
  level: number | null,
  needed: number | null,
  made: number,
  since: number | null,
  now: number
): string | null {
  if (level === null) return null;
  const perHour = since === null ? null : ratePerHour(made, since, now);
  const wait = perHour === null || needed === null ? '?' : formatHours(needed / perHour);
  const need = needed === null ? '?' : withCommas(needed);
  return `{Level: ${level}  Needed: ${need}  Will level in: ${wait}}`;
}

/** `{9 lives remaining}`. */
export function formatLives(lives: number | null): string | null {
  return lives === null ? null : `{${lives} lives remaining}`;
}

/** `{0 copper}` — the purse as `Wealth:` states it, in copper. */
export function formatWealth(wealth: number | null): string | null {
  return wealth === null ? null : `{${wealth} copper}`;
}

/** `{0/2400 - None}` — the figures and the server's own word for the load. */
export function formatEncumbrance(
  carried: number | null,
  max: number | null,
  word: string | null
): string | null {
  if (carried === null || max === null) return null;
  return word === null ? `{${carried}/${max}}` : `{${carried}/${max} - ${word}}`;
}

/**
 * `{Newhaven, Village Entrance (Exits: N,S,W,SE)}` — the canonical short
 * direction codes upper-cased, which is what MegaMUD prints too. A room with
 * no exits read prints the name alone rather than an empty list claiming
 * there are none.
 */
export function formatWhere(name: string | null, exits: readonly string[]): string | null {
  if (name === null) return null;
  if (exits.length === 0) return `{${name}}`;
  return `{${name} (Exits: ${exits.map((exit) => exit.toUpperCase()).join(',')})}`;
}

/**
 * `{No one}` when the room holds nobody but this character, and the names
 * comma-joined without a space otherwise, the way `@what` joins the floor.
 * Both captured (`captures/215`, `captures/216`, 2026-08-29): `{Probe}` is
 * what MegaMUD 2.1 answered with one other character standing there, which is
 * the frame the analogy had predicted; the join between several names is the
 * analogy still, since only one was ever in the room. Who is named is the
 * caller's decision, stated there.
 */
export function formatWho(names: readonly string[]): string {
  return names.length === 0 ? '{No one}' : `{${names.join(',')}}`;
}

/**
 * `{newbie manual,large sign}` — the floor, comma-joined without a space —
 * and `{Nothing}` for a bare one. Both captured: the empty answer arrived on
 * 2026-08-29 (`captures/218`) once the MegaMUD had been stepped onto a floor
 * with nothing on it, since its own room holds two fixtures nothing will lift.
 */
export function formatWhat(items: readonly string[]): string {
  return items.length === 0 ? '{Nothing}' : `{${items.join(',')}}`;
}

/**
 * `{no}`, or `{yes: 1}` — the two answers on the wire, and nothing wider.
 *
 * Six asks, six `{no}`s at first; the yes arrived on 2026-08-29
 * (`captures/217`) once a character of ours had put one copper ring in the
 * other client's hands: `@have copper ring` → `{yes: 1}`, and `@have ring`
 * for the same item → `{no}`. Two asks show exactly that much: the full name
 * answers, a word from inside it does not. What MegaMUD prints for a second
 * copy — `{yes: 2}`, a stack, a fixed `1` — nobody has seen, and this is a
 * frame another client parses, so a count above one returns null and the
 * responder says so instead of guessing.
 */
export function formatHave(count: number): string | null {
  if (count === 0) return '{no}';
  if (count === 1) return '{yes: 1}';
  return null;
}

/**
 * `{ON: Combat,Pre(attacks),Heal,…}` then `{OFF: Nuke,Search,Melee,Hangup}` —
 * two telepaths, MegaMUD's frame with **this client's** switches in it. The
 * words are ours because the settings are: MegaMUD's `Nuke` and `Abils` have
 * no counterpart here, and answering with its words would name settings this
 * client does not have. A decision, and the decision is that the frame is
 * what another client's reader parses and the words are what a person reads.
 */
export function formatSettings(on: readonly string[], off: readonly string[]): [string, string] {
  // An empty half says so the way the rest of this file does -- `{No one}`,
  // `{none}`, `{no}` -- rather than printing a frame with nothing in it.
  const list = (names: readonly string[]): string =>
    names.length === 0 ? 'none' : names.join(',');
  return [`{ON: ${list(on)}}`, `{OFF: ${list(off)}}`];
}

/**
 * `{MANUAL: Waiting for instructions ... -Hidden}` — MegaMUD's frame: a mode
 * word, a colon, what it is doing, and a suffix for hiding. This client's
 * modes are its own — `WALK` to somewhere, `LOOP` on a named loop, `IDLE` —
 * and the suffix follows the three-state `Stealth` it models: `-Sneaking`,
 * nothing for a character known to be seen, and `-Stealth?` for one nobody
 * has said anything about. Unknown is not "not sneaking": a leader who read
 * no suffix as visible would walk a party into a lair on a guess, which is
 * the guess the three-state exists to refuse. The same decision as
 * `@settings`: the frame is theirs, the words are ours.
 */
export function formatStatus(
  mode: 'walk' | 'loop' | 'idle',
  doing: string,
  stealth: Stealth
): string {
  const word = mode === 'walk' ? 'WALK' : mode === 'loop' ? 'LOOP' : 'IDLE';
  const suffix = stealth === 'sneaking' ? ' -Sneaking' : stealth === 'unknown' ? ' -Stealth?' : '';
  return `{${word}: ${doing}${suffix}}`;
}

/** `{mudengine 0.5.0}`, in the shape of `{MegaMMUD 2.1}`. */
export function formatVersion(client: string, version: string): string {
  return `{${client} ${version}}`;
}

/**
 * Which remotes one player may use, and on what grounds.
 *
 * ## Why the grounds are gone
 *
 * There were three of them until 2026-08-29 — `named`, `party`, `gang` — and a
 * ground was a reason somebody was allowed **everything**. That is the shape
 * this replaced, and the reason is that the two questions people actually ask
 * are per command:
 *
 * - *"my gang may ask where I am; nobody may run a command on me"* was
 *   inexpressible. `gang` granted `@do` along with `@where`.
 * - *"everybody in the gang except Rend"* was inexpressible too, because a
 *   ground had no per-person exception and a block was all-or-nothing.
 *
 * So permission is now stated **per remote, per player**, with two lists behind
 * it — one for the gang, one for the party.
 *
 * ## The party is a list, and it was never a ground
 *
 * `PARTY` was a *ground* until 2026-08-29 and was dropped, because a ground
 * allowed somebody **everything** and a party is a group anybody can invite
 * anybody into: it was a permission anybody could grant themselves by sending
 * an invitation. It comes back (2026-09-02) as a **list**, which is a different
 * object and answers that objection rather than ignoring it:
 *
 * - It grants named commands and never all of them, and the shipped default is
 *   **two**: `@health` and `@bless-expired`, both facts about this character's
 *   own body that the party listing already states more coarsely, and neither
 *   of which does anything to it. Four more were on that list and came off on
 *   review — `RemotesConfig.party` has each one's reason, and the short
 *   version is that `@where` and `@status` say *where to find me* and `@wait`
 *   stops the character's lap with no deadline.
 * - It is gated on having **joined**, not on having been invited. An offer
 *   nobody accepted is not membership, which is half the hole the ground had.
 *   The other half is open and is written down rather than glossed: on this
 *   realm following somebody is how a party is joined, and whether the server
 *   honours an uninvited `follow` has never been asked of the wire
 *   (`npm run probe:party`). That is why the default is two facts about this
 *   character's own body rather than a membership test anybody can pass.
 * - `deny` on a player still beats it, so *"the party, except Rend"* is
 *   expressible where it was not on a ground.
 *
 * Anybody widening it past that is doing so by name, on a screen that says
 * whose typing it lets move this character.
 *
 * ## Three places a grant can come from, and one that outranks them all
 *
 * For one sender and one remote, in this order:
 *
 * 1. **`deny` on that player** — refused, whatever else says otherwise. This is
 *    what makes "the gang, except Rend" expressible, and it is checked first
 *    and unconditionally for the same reason the old block list was: a
 *    permission somebody else can hand out must not be able to lift it.
 * 2. **`allow` on that player** — allowed, whether or not they are in the gang.
 * 3. **the gang list**, if the asker is in this character's gang.
 * 4. **the party list**, if the asker has joined this character's party.
 *
 * The gang is read before the party only so a verdict names the standing
 * relationship rather than the transient one; both grant, and neither can
 * lift a `deny`.
 *
 * Anything else is refused. **Everything is off until somebody says otherwise**
 * — an absent player is an empty grant, and an empty list grants nothing —
 * which is the only honest default for a channel whose whole risk is who is on
 * the other end.
 *
 * ## The gang list is one list, and it is about *this character's* gang
 *
 * Not a map keyed by gang name. A character is in one gang at a time and the
 * card that edits this shows that gang, so a second key would be a distinction
 * the surface cannot make. The consequence is stated rather than hidden: a
 * character that **leaves Valor and joins Doom hands Doom the same list**, so
 * the Gang card names the gang the list currently applies to on every draw, and
 * `Remotes` says the gang out loud in every notice it writes about one.
 *
 * A member who leaves loses the grant the moment the roster says so, because
 * nothing is copied onto them: membership is evaluated per command from
 * `RemoteEvidence`, so "they are no longer in the gang" and "they no longer
 * have the gang's remotes" are the same fact rather than two that can drift.
 *
 * ## What says who is in a gang
 *
 * **A gangpath does not establish that its sender is in this gang**, which is
 * the tempting shortcut and is wrong twice over:
 *
 * - This character's *own* outgoing gangpath comes back as a third-person line
 *   naming itself — `bg crit` -> `Kaverin gangpaths: crit`, captures/068 — so
 *   the channel does not even establish that the speaker is somebody else.
 * - An admin ghosting a gangpath produces a line the pattern's own non-capturing
 *   prefix makes byte-identical to a real one downstream (`patterns.ts`, and
 *   docs/greatermud/communication.md for the prefix; not observed on the wire).
 *
 * There is also **no gang roster command**: `Broadgang` (`bg`, `gb`) is the only
 * gang verb in the server's own command table, confirmed against
 * docs/greatermud/commands.md and `src/shared/commands.ts`.
 *
 * What there *is*, and what is read (2026-08-28): a `who` row names a gang
 * behind its title — `Squire  of EyeExploredDora`, behind a double space —
 * and a `look <player>` answers `[ Nester TheDupe ] (Old Guard)`; 13 corpus
 * files across 15 gangs, and the two agree where both appear. Both land on
 * the realm roster (`Adventurer.gang`), and **this character's own row is on
 * that roster too**, which is what makes a comparison possible without a
 * self-`look`. `Remotes.evidenceAbout` compares the two rows.
 *
 * The gang list therefore grants only when both rows have named the same gang,
 * and evaluates to *unresolved* while either is unknown — never to a grant. The
 * project's standing rule applied to a permission: **unknown is never the
 * reassuring answer**, and here the reassuring answer is the one that lets a
 * stranger through. A refusal says the ground was unresolved so somebody who
 * configured the gang list is told what would settle it.
 */

/**
 * The standing decision about one remote for one player, as a form states it.
 *
 * `allow` and `deny` are what somebody clicked. `unset` is the absence of a
 * decision and is not a third thing anybody configures — it is what every pair
 * starts as, and what falls through to the gang list.
 *
 * **The one place the union is spelled.** The flyout's three buttons, the IPC
 * payload, the editor that writes it and the handler that validates it all read
 * `RemoteStance` from here — the alternative was the same three string literals
 * written out in five files, each type-checking on its own while the
 * hand-rolled validator in main silently refused a fourth. That is the
 * `GUARD_FIELDS`/`readField` shape, and `isRemoteStance` is the runtime half so
 * the two cannot drift.
 */
export const REMOTE_STANCES = ['allow', 'deny', 'unset'] as const;

export type RemoteStance = (typeof REMOTE_STANCES)[number];

/** Whether a value off the wire or out of a form is a stance this client knows. */
export function isRemoteStance(value: unknown): value is RemoteStance {
  return typeof value === 'string' && (REMOTE_STANCES as readonly string[]).includes(value);
}

/** Whether a value off the wire or out of a form is a remote this client knows. */
export function isRemoteName(value: unknown): value is RemoteName {
  return typeof value === 'string' && (REMOTE_NAMES as readonly string[]).includes(value);
}

/**
 * What one player may and may not ask for.
 *
 * Two lists rather than a map from remote to stance, because that is the shape
 * a person reads in their own options file: *"Soul may ask these, and may never
 * ask those"*. `unset` is simply absence from both, which is why it needs no
 * spelling on disk — and a name in both lists is resolved by `deny` winning,
 * the same precedence the old block list had.
 */
export interface RemoteGrant {
  allow: RemoteName[];
  deny: RemoteName[];
}

/** An empty grant: the state every name starts in, and the one nothing is allowed by. */
export const NO_GRANT: RemoteGrant = { allow: [], deny: [] };

/**
 * How access is configured, mirrored from `RemotesConfig` so this module stays
 * dependency-free and the decision can be tested against a literal.
 */
export interface RemoteAccess {
  /** Remotes anybody in this character's gang may use. */
  gang: readonly RemoteName[];
  /** Remotes anybody who has **joined this character's party** may use. */
  party: readonly RemoteName[];
  /** Per player, keyed by the **lower-cased** name, like `PlayerRegistry`. */
  players: Readonly<Record<string, RemoteGrant>>;
}

/**
 * What is known about the asker at the moment they asked.
 *
 * Passed in rather than looked up so the decision below is pure: the same
 * inputs give the same verdict, which is what makes it testable without a
 * session, a socket or a tracker.
 *
 * `inGang` is `null` rather than `false` for the reason the whole codebase
 * distinguishes null from zero — an unknown membership is *absence*, and a
 * `false` here is the client claiming to know somebody is not in its gang.
 * `Remotes.evidenceAbout` produces `false` only when both this character's row
 * and the asker's were written in full by a listing and name different gangs
 * (or none); anything less said is `null`.
 */
export interface RemoteEvidence {
  /** In this character's gang, or `null` while nothing has said. See the note above. */
  inGang: boolean | null;
  /**
   * On this character's party listing, having **joined** it.
   *
   * Two states rather than three, and the asymmetry with `inGang` is the
   * point: a gang is learned from a `who` row that may never have been read,
   * so *nobody has said* is a real state there. The party roster is this
   * client's own maintained listing — `party` establishes it and the server's
   * own `joins`/`leaves` sentences keep it true — so a name that is not on it
   * is a name that is not in the party, which is a fact rather than a gap.
   *
   * An outstanding invitation is **not** membership: `invited` is an offer
   * nobody has accepted, and treating it as a grant would let anybody hand
   * themselves this character's party remotes by typing `invite`.
   */
  inParty: boolean;
}

/**
 * What the access rules said, and why.
 *
 * The *why* is not decoration. A refusal that says only "no" leaves somebody
 * unable to tell a deny from an unconfigured client from a gang that could not
 * be evaluated, and those need three different actions from them. Every branch
 * below therefore names its ground, and `Remotes` says it out loud.
 */
export type RemoteVerdict =
  | { allowed: true; because: 'player' | 'gang' | 'party' }
  | { allowed: false; because: 'denied' }
  | {
      allowed: false;
      because: 'not-granted';
      /**
       * True when the gang list carries this remote and nothing has yet said
       * whether the asker shares this character's gang — so the refusal can
       * name what would settle it instead of reading as "you are a stranger".
       */
      gangUnresolved: boolean;
      /**
       * True when the party list carries this remote and the asker is not on
       * the party listing — so the refusal says *you are not in my party*
       * rather than *you are a stranger*, which are two different things to
       * somebody who was in it a minute ago.
       */
      notInParty: boolean;
    };

/** The grant a name is filed under, or an empty one. Case-insensitive, like the registry. */
export function grantFor(access: RemoteAccess, from: string): RemoteGrant {
  return access.players[from.trim().toLowerCase()] ?? NO_GRANT;
}

/** Names are compared case-insensitively: the server is inconsistent about case. */
function has(list: readonly RemoteName[], name: RemoteName): boolean {
  return list.includes(name);
}

/**
 * What this player's own entry says about one remote, ignoring the gang.
 *
 * The flyout's three buttons show *the decision somebody made*, not the
 * verdict — those are different, and conflating them is how a person clicks
 * Allow on somebody the gang already covered and sees nothing change.
 */
export function stanceFor(access: RemoteAccess, from: string, name: RemoteName): RemoteStance {
  const grant = grantFor(access, from);
  if (has(grant.deny, name)) return 'deny';
  if (has(grant.allow, name)) return 'allow';
  return 'unset';
}

/**
 * May this player use this remote?
 *
 * Pure, and the single place the question is answered — `Remotes` calls it and
 * does not re-derive any part of it, so the flyout showing somebody as allowed
 * and the engine answering them cannot disagree.
 *
 * The order is load-bearing and is asserted by the tests: deny beats
 * everything, then the player's own allow, then the gang. **There is no ground
 * meaning "everybody"**, and the absence is deliberate: it is not a reason, it
 * is the absence of a gate.
 */
export function judgeRemote(
  from: string,
  name: RemoteName,
  access: RemoteAccess,
  evidence: RemoteEvidence
): RemoteVerdict {
  const grant = grantFor(access, from);

  // First and unconditionally. A deny is about one person, by name, on purpose.
  if (has(grant.deny, name)) return { allowed: false, because: 'denied' };
  if (has(grant.allow, name)) return { allowed: true, because: 'player' };

  const fromGang = has(access.gang, name);
  if (fromGang && evidence.inGang === true) return { allowed: true, because: 'gang' };

  const fromParty = has(access.party, name);
  if (fromParty && evidence.inParty) return { allowed: true, because: 'party' };

  return {
    allowed: false,
    because: 'not-granted',
    gangUnresolved: fromGang && evidence.inGang === null,
    notInParty: fromParty && !evidence.inParty
  };
}

/**
 * Could this sender use **anything** at all?
 *
 * Not a shortcut for `judgeRemote` — it answers a different question, and only
 * one caller has it: whether a command that arrived on a channel this client
 * never answers on is worth reporting. An untrusted stranger gossiping
 * `@health` at the whole realm must not produce a notice on every mudengine
 * character logged in, once per line, for free.
 *
 * A `deny` does not subtract here: somebody with one remote allowed and one
 * denied is still somebody this character has a relationship with, and their
 * attempts are worth seeing.
 */
export function reachableBy(from: string, access: RemoteAccess, evidence: RemoteEvidence): boolean {
  const grant = grantFor(access, from);
  if (grant.allow.length > 0) return true;
  if (evidence.inParty && access.party.length > 0) return true;
  return evidence.inGang === true && access.gang.length > 0;
}

/**
 * Whether this client could ever answer a remote, whatever the permissions say.
 *
 * `refused` and `unread` never round-trip — the first is a standing refusal
 * this client makes on its own account and the second has no captured reply
 * format — so granting one buys nothing. The settings surfaces show all
 * {@link REMOTE_NAMES} and make only these toggleable, and "allow all" means
 * all of these: a permission that cannot take effect is one somebody sets and
 * waits to see work.
 */
export function isActionable(name: RemoteName): boolean {
  const support = REMOTES[name].support;
  return support === 'answered' || support === 'acted';
}

/** Every remote a grant may usefully carry, in the vocabulary's own order. */
export const ACTIONABLE_REMOTES: readonly RemoteName[] = REMOTE_NAMES.filter(isActionable);
