/**
 * Remote control as a whole window (todo 20261031-1156-01, the user's
 * 2026-11-11 reversal of the narrow contract): a character another player
 * gives control is a session in the controller's client, every card and the
 * console its own, its calls answered by the sharer's client over the
 * gateway. This file is what both ends agree on: which calls cross and which
 * stay, which pushes cross, and how a message is cut into frames.
 *
 * Each channel has a rule, and the tables are records over every channel, so
 * a channel added without one does not compile. A call crosses only when its
 * session argument is the shared character; the sharer checks the rule again
 * and never takes the controller's word for it. Nothing that dials, hangs up,
 * reads or writes the account, deletes, changes who may control or share, or
 * touches the sharer's files crosses. See `mudengine-session` › *Peers*.
 */
import { Invoke, Push, Send } from './ipc';
import { MOST_PART_NUMBER, RELAY_PART_CHARS, type RelayPart } from './peerWire';

/**
 * What a call naming a session does when that session is a character shared
 * with this client. `at` is the argument that names it.
 */
export type RelayRule =
  /**
   * Sent to the sharer's client and answered by it; with `requires`, only
   * where that argument is that value, and refused otherwise.
   */
  | {
      readonly kind: 'forward';
      readonly at: number;
      readonly requires?: { readonly at: number; readonly value: string };
    }
  /** Refused here and by the sharer, said as refused. */
  | { readonly kind: 'refused'; readonly at: number }
  /** Ends the control: closing the shared character's tab. */
  | { readonly kind: 'close'; readonly at: number }
  /** Names no session: always this client's own. */
  | { readonly kind: 'local' };

const forward: RelayRule = { kind: 'forward', at: 0 };
const refused: RelayRule = { kind: 'refused', at: 0 };
const local: RelayRule = { kind: 'local' };

export const RELAY_INVOKE: { readonly [K in keyof typeof Invoke]: RelayRule } = {
  // Dialling and hanging up are the sharer's: a hangup costs on this realm family.
  connect: refused,
  disconnect: refused,
  getState: forward,
  getTelnetLog: forward,
  getLines: forward,
  // The raw trace carries what was typed at the login.
  getDebug: refused,
  getUnread: forward,
  saveDebug: refused,
  getCharacter: forward,
  routeTo: forward,
  routeBetween: forward,
  walkPages: forward,
  walkPage: forward,
  walkRoute: forward,
  collectThenWalk: forward,
  previewAreaSearch: forward,
  searchArea: forward,
  previewMobFind: forward,
  findMob: forward,
  cashRunTokens: forward,
  startCashRun: forward,
  startMoving: forward,
  stopMoving: forward,
  inheritedMobRules: local,
  // A realm's monster rules are every character's of the sharer there.
  treatMonster: refused,
  portrait: forward,
  shares: refused,
  controlOpen: refused,
  controlClose: refused,
  controlStop: refused,
  savePortrait: refused,
  roomArt: forward,
  saveCardLayout: local,
  chooseCardLayoutFile: local,
  readCardLayout: local,
  walkOnWithoutParty: forward,
  stepBack: forward,
  listLoops: forward,
  startLoop: forward,
  recentLoops: forward,
  runLoop: forward,
  loopJoin: forward,
  loopThrough: forward,
  reverseLoop: forward,
  loopCatalogue: local,
  draftLoop: forward,
  getWalk: forward,
  getAutomation: forward,
  listExtensions: local,
  extensionAction: forward,
  setTask: forward,
  listSessions: local,
  listProfiles: local,
  loadProfile: refused,
  unloadProfile: { kind: 'close', at: 0 },
  attach: forward,
  detach: forward,
  backscrollPage: forward,
  reorderSessions: local,
  popOut: refused,
  popIn: refused,
  gatherWindows: local,
  raiseWindow: local,
  getConfig: local,
  getInternal: local,
  revealConfig: local,
  revealProfiles: local,
  revealLogs: local,
  browseHome: local,
  copyText: local,
  pasteText: local,
  copyImage: local,
  // The whole file, the account and its password among it.
  saveProfile: refused,
  deleteProfile: refused,
  saveServer: local,
  saveGlobal: local,
  // Who may send this character remotes is its player's alone.
  setRemoteGrant: refused,
  setGangRemotes: refused,
  setRemoteGangpath: refused,
  setAutomationSwitch: forward,
  setThreshold: forward,
  setSupplies: forward,
  setAutoDrop: forward,
  deleteServer: local,
  // A loop saved for the shared character goes into its own file, never the sharer's shared folders.
  addLoop: { kind: 'forward', at: 1, requires: { at: 0, value: 'profile' } },
  settingsSnapshot: local,
  chooseRealm: local,
  exportCharacter: refused,
  chooseCharacterFile: local,
  importCharacter: local,
  huntingGrounds: forward,
  trainers: forward,
  banks: forward,
  supplyCounters: forward,
  nearestPlaces: forward,
  itemsServing: forward,
  wards: forward,
  invokeChoices: forward,
  blessingChoice: forward,
  searchRooms: forward,
  mobNames: forward,
  worldInfo: forward,
  realmWorld: local,
  questBook: forward,
  questErrand: forward,
  questPlan: forward,
  questReach: forward,
  questRun: forward,
  questStop: forward,
  gearChoices: forward,
  gearBlessItems: forward,
  gearPlan: forward,
  gearTrip: forward,
  gearStop: forward,
  localMap: forward,
  gameMap: forward,
  roomBrief: forward,
  slotGear: forward,
  chosenWords: forward,
  wearer: forward,
  lookup: forward,
  // What the realm remembers is every character's of the sharer there, as its monster rules are.
  forget: refused,
  forgetFind: refused,
  // Forgetting a character's records, and logging in at its last lives, are its player's.
  forgetCharacter: refused,
  answerLowLives: refused,
  resetStats: forward,
  names: forward,
  ask: forward,
  locate: forward,
  gear: forward,
  terminalAct: forward,
  askRemote: forward
};

export const RELAY_SEND: { readonly [K in keyof typeof Send]: RelayRule } = {
  clientReady: local,
  input: forward,
  macro: forward,
  dropMacro: forward,
  // The sharer's terminal is the size its own window made it; the realm wraps to that.
  resize: refused,
  lostEnter: forward,
  diagnostics: local,
  debugFeed: local
};

/**
 * The pushes about the shared character that cross to the controller.
 * Not the diagnostics feeds (each window asks for its own), nothing about
 * sharing, and no prompt only the sharer's player may answer.
 */
export const RELAY_PUSH: { readonly [K in keyof typeof Push]: boolean } = {
  data: true,
  marks: true,
  state: true,
  telnet: true,
  notice: true,
  config: false,
  internal: false,
  line: false,
  debug: false,
  block: true,
  character: true,
  players: true,
  portrait: true,
  shares: false,
  roomArt: true,
  walk: true,
  loop: true,
  automation: true,
  verdict: true,
  asks: true,
  statsBase: true,
  sessions: false,
  profiles: false,
  learned: true,
  finds: true,
  shops: true,
  characterReset: false,
  lowLives: false,
  questSaid: true,
  questRun: true,
  gearTrip: true
};

const byWire = <T>(
  channels: Readonly<Record<string, string>>,
  table: Readonly<Record<string, T>>
): ReadonlyMap<string, T> =>
  new Map(Object.entries(channels).map(([name, wire]) => [wire, table[name] as T]));

const INVOKE_RULES = byWire<RelayRule>(Invoke, RELAY_INVOKE);
const SEND_RULES = byWire<RelayRule>(Send, RELAY_SEND);
const PUSH_CROSSES = byWire<boolean>(Push, RELAY_PUSH);

/** A call's rule by its wire name; a channel this build does not know is refused. */
export function relayRule(kind: 'invoke' | 'send', channel: string): RelayRule {
  return (kind === 'invoke' ? INVOKE_RULES : SEND_RULES).get(channel) ?? refused;
}

/** Whether `args` meet what a forwarding rule requires of its other arguments. */
export function relayAllows(rule: RelayRule, args: readonly unknown[]): boolean {
  if (rule.kind !== 'forward') return false;
  return rule.requires === undefined || args[rule.requires.at] === rule.requires.value;
}

/** Whether a push on `channel` about the shared character crosses. */
export const relayPushCrosses = (channel: string): boolean => PUSH_CROSSES.get(channel) === true;

/**
 * What a crossing call names its session by: the controller's client does not
 * know the sharer's session, and the sharer's does not know the controller's.
 * Each end puts its own in place of this.
 */
export const SHARED_SESSION = '@shared';

/**
 * The largest message sent or put back together. The sharer answers a call
 * whose answer is larger with a refusal (a console read far back, which the
 * controller can ask for in smaller pages), and the gateway's buffer holds
 * two of these.
 */
export const RELAY_MOST_MESSAGE_CHARS = 4_194_304;

/** The message number after `n`: both ends read it, as a frame number and a call's id, from 1. */
export const nextRelayNumber = (n: number): number => (n + 1 >= MOST_PART_NUMBER ? 1 : n + 1);

/** A whole message's text read by `parser`, or null where it is not JSON or not what it should be. */
export function readRelayMessage<T>(text: string, parser: (value: unknown) => T | null): T | null {
  try {
    return parser(JSON.parse(text));
  } catch {
    return null;
  }
}

/** `text` as the frames that carry it, numbered `n`. */
export function* relayParts(n: number, text: string): Generator<RelayPart> {
  for (let at = 0; at < text.length || at === 0; at += RELAY_PART_CHARS) {
    const end = at + RELAY_PART_CHARS;
    yield { n, text: text.slice(at, end), more: end < text.length };
  }
}

/** The parts of each message under way, put back together in order. */
export class RelayJoin {
  private readonly open = new Map<number, string[]>();
  private chars = 0;

  /** The whole message once its last part is in, null before; 'too-long' past the bound. */
  take(part: RelayPart): string | null | 'too-long' {
    const pieces = this.open.get(part.n) ?? [];
    pieces.push(part.text);
    this.chars += part.text.length;
    if (this.chars > RELAY_MOST_MESSAGE_CHARS) {
      this.clear();
      return 'too-long';
    }
    if (part.more) {
      this.open.set(part.n, pieces);
      return null;
    }
    this.open.delete(part.n);
    const text = pieces.join('');
    this.chars -= text.length;
    return text;
  }

  clear(): void {
    this.open.clear();
    this.chars = 0;
  }
}

const REMOTE_PREFIX = '@remote:';

/**
 * The session a character shared with `via` is in this client: never a
 * profile id, which holds no `@` or `:` (`readProfileId`), so nothing here
 * can take it for a file of its own.
 */
export const remoteSessionId = (via: string, name: string): string =>
  `${REMOTE_PREFIX}${via}:${name.toLowerCase()}`;

export const isRemoteSessionId = (id: string): boolean => id.startsWith(REMOTE_PREFIX);
