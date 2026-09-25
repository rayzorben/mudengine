/**
 * What a card is and where one can be: the vocabulary every card surface
 * reads (`CARDS`, `CardId`, what can be set on one and which may hide while
 * empty) and the shape of a character's arrangement, which `useCardLayout`
 * keeps and the palette, the settings popup and the drag machine read.
 *
 * Beneath the hook rather than in it (todo 733), so `lib/` reads it without
 * importing a hook. See `mudengine-ui` › `parts/cards.md`.
 */
import { t } from './i18n';
import type { Appearance, ThemeId } from '@shared/themes';
import type { TalkLayout, TalkStamp } from '@shared/talk';
import type { StatsGraph } from '@shared/tally';

/**
 * Every card the rail can hold, and the order a rail that has never been
 * arranged holds them in.
 *
 * This list is the *vocabulary*, not the layout. Once a character has arranged
 * its own rail the stored order wins, and this is only consulted for cards that
 * arrangement has never seen — a card added by a later build appears rather
 * than staying invisible to everyone who already has a saved layout.
 */
export const CARDS = [
  /*
   * The toolbar first, and it is the one card with a *placement* in its
   * shipped arrangement rather than only a position: it docks above the
   * console (`DEFAULT_ABOVE`), one icon high, which is where a toolbar
   * belongs and is the one thing the rail cannot give it — a rail is a column,
   * and a row of glyphs down a column is a list.
   *
   * It is still an ordinary card underneath: draggable onto the rail, over the
   * console as a float, or into the strip below. Nothing about it is special
   * except where it starts.
   */
  { id: 'toolbar', label: t('cards.toolbar.title') },
  /*
   * The character itself, first: a client for playing several characters
   * whose rail opened on bars and a room and never on *who this is*. It
   * carries the whole stat sheet, the pack and the supplies list, and its
   * title is the character's own name — see `SelfCard`.
   */
  { id: 'self', label: t('cards.self.title') },
  /*
   * Vitals and Combat adjacent, at the top.
   *
   * They are the two readouts a decision gets made off under pressure — how
   * much health is left, and how the thing it is fighting is holding up — so
   * they sit where the eye already is. The Combat card is drawn whether or not
   * there is a fight (`CardSettings.autoHide` is what changes that, per
   * character): a card that appeared when a fight started and vanished when it
   * ended moved everything below it on the rail several times a minute.
   * Everything below is arrangeable and remembered per character; this is only
   * what a rail that has never been arranged looks like.
   */
  { id: 'vitals', label: t('cards.vitals.title') },
  { id: 'combat', label: t('cards.combat.title') },
  { id: 'room', label: t('cards.room.title') },
  { id: 'map', label: t('cards.map.title') },
  /*
   * Where a loop is drawn: the map again, as a chooser rather than a
   * picture. Put away by default and brought out as a float by the palette,
   * the toolbar or the Map card's own action, because a map you click rooms
   * on wants more of the screen than a rail slot and it is a tool reached
   * for, not a readout watched.
   */
  { id: 'builder', label: t('cards.builder.title') },
  /*
   * One card, two faces: `ROUTE` and `LOOP`.
   *
   * They were `walk` and `loop`, two cards side by side on every rail, and
   * each had grown a copy of the other — the Route card carried the loop's
   * name, stop and a `Stop looping` button, and the Loop card carried a stop
   * counter the Route card was already drawing as a bar. They are one
   * question asked twice (*where is this character headed*) and they are
   * mutually exclusive in practice, which is what a face is for. See
   * `NavigationCard`.
   *
   * A stored layout naming `walk` or `loop` drops on load, like any id this
   * list no longer has, and this lands in its shipped position — which is
   * where both of them were.
   */
  { id: 'navigation', label: t('cards.navigation.title') },
  { id: 'party', label: t('cards.party.title') },
  { id: 'notifications', label: t('cards.alerts.title') },
  { id: 'realm', label: t('cards.realm.title') },
  /*
   * Beside Realm, because they answer two halves of one question. Realm is the
   * listing the server maintains — who is logged in *now*, and what the realm
   * thinks of them. Players is what this client has accumulated about each of
   * them and keeps after they walk out: where they were last seen, the numbers
   * they answered `@health` with, and whether their `@` commands are answered
   * at all.
   *
   * They are two cards rather than two faces because they cut the same people
   * by two different questions — Realm by **standing**, who is dangerous;
   * Players by **reach**, who can talk to this character and who has been
   * trying — and a table takes one filtering dimension.
   */
  { id: 'players', label: t('cards.players.title') },
  /*
   * And beside those two, the third cut of the same people: the gang, which is
   * a group the *realm* maintains rather than one this client observed. It is a
   * card and not a settings page because its subject is learned from the wire —
   * which gang this character is in, and who else is in it, both come off the
   * `who` listing and both change while somebody is playing — and because what
   * it edits is a permission that applies to all of them at once.
   */
  { id: 'gang', label: t('cards.gang.title') },
  /*
   * There is no Player card. One person, chosen by clicking a name on either
   * listing, is a *question asked now* rather than an instrument watched, so it
   * is a slide-out beside the listing (`PlayerFlyout`) — a card for it was one
   * more slot on a rail somebody wanted short, and a face of Players could not
   * be read beside the listing it was chosen from. A stored layout naming
   * `player` drops on load, like any id this list no longer has.
   */
  { id: 'inventory', label: t('cards.inventory.title') },
  /*
   * Beside Carrying, because the two are one question asked about two places:
   * what this character has on them, and what it has left somewhere safe.
   *
   * **A card and not a face of Room**, unlike the shop. A shop is a property of
   * the room the character is standing in and stops being true on the next
   * step; a balance is *accumulated* — it is learned in one town and still
   * wanted in another, which is the Players card's justification exactly ("what
   * this client has accumulated about each of them and keeps after they walk
   * out"). The room's own `BANK` face answers "what is in this vault"; nothing
   * standing in one room can answer "and what about the other six".
   *
   * Put away by default for the Gang card's reason: most characters have banked
   * nowhere, and a card reading "no bank has said" on every rail is a slot
   * spent on an absence.
   */
  { id: 'banks', label: t('cards.banks.title') },
  /*
   * The realm's quests, derived from its own text blocks — the realm has no
   * Quests table and never had one (`indexQuests.ts`).
   *
   * Beside the vaults for the same reason those are a card: it is *accumulated*
   * knowledge about the realm rather than about the room being stood in, so it
   * is wanted in one town and still wanted in another. Put away by default,
   * like the Gang and the vaults — most evenings are a loop, and a book of
   * thirty-nine quests on every rail is a slot spent on something read
   * occasionally and deliberately.
   */
  { id: 'quests', label: t('cards.quests.title') },
  /*
   * Where to hunt, from where the character stands: the lairs within reach,
   * priced for this character, best first. Put away by default and reached
   * through the palette (*Where should I hunt?*), because it is a question
   * asked before an evening rather than a readout watched through one.
   */
  { id: 'hunting', label: t('cards.hunting.title') },
  /*
   * There is no Shop card. A shop is a property of a *room*, so it is a face of
   * the Room card — `ROOM · SHOP`, and `TEMPLE`, `BANK` or `TRAINER` where the
   * realm says so. As a card of its own it appeared and disappeared from the
   * rail as the character walked in and out of shops, which is the churn a
   * fixed card exists to prevent applied to the rail itself. A stored layout
   * naming `shop` drops on load, like any id this list no longer has.
   */
  { id: 'conversation', label: t('cards.talk.title') },
  /*
   * The reference a player used to keep on paper — what the realm data knows
   * about any name: a monster's health and temper, an item's price, weight
   * and provenance, a spell's cost and level. Last of the playing cards
   * because it is *looked up* rather than watched; clicking a name on the
   * Room, Carrying or Shop cards lands here. It replaced a Spells card that
   * listed every spell in the realm, which answered no question anybody
   * standing in a room was asking.
   */
  { id: 'reference', label: t('cards.reference.title') },
  /*
   * How the fighting has actually been going — the MegaMUD accuracy window's
   * question, answered from the stream. Put away by default, like Banks and
   * Gang: it is a card somebody opens to *ask* something, not one they watch,
   * and the rail is short on purpose.
   */
  { id: 'stats', label: t('cards.stats.title') },
  // The diagnostics half. Toggled as a group by the rail shortcut, and each one
  // can still be put away on its own — "all cards" means all of them.
  { id: 'session', label: t('cards.session.title') },
  { id: 'link', label: t('cards.link.title') },
  { id: 'automation', label: t('cards.automation.title') },
  { id: 'stream', label: t('cards.stream.title') }
] as const;

export type CardId = (typeof CARDS)[number]['id'];

export function cardLabel(id: CardId): string {
  return CARDS.find((card) => card.id === id)?.label ?? id;
}

/**
 * The diagnostics group, toggled together by the rail shortcut and drawn for
 * a character that is not in the realm: a readout of the wire, not of play.
 */
export function isDiagnosticCard(id: CardId): boolean {
  return id === 'session' || id === 'link' || id === 'automation' || id === 'stream';
}

/**
 * A card lifted off the rail and left over the console.
 *
 * Geometry is in **fractions of the workspace**, never pixels. Users run
 * display scaling, drag windows between monitors and change the terminal font
 * size; a float remembered in pixels lands somewhere else — or off screen
 * entirely — the first time any of those changes. This is the same rule the
 * layout path already follows for columns.
 */
export interface FloatState {
  id: CardId;
  /** Stays in view whichever character is shown. See `CardLayoutApi.pin`. */
  pinned?: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * How solid the card is, 0–1. One number, two alphas.
   *
   * There is a **floor** and no ceiling: a card cannot be made to vanish,
   * because one that has is one nobody can drag back, but it can be made
   * solid. See `floatAlphas`.
   */
  solidity: number;
}

/**
 * What a player has set on one card, for one character.
 *
 * Kept beside the arrangement rather than in the options file, and for the
 * same reason the arrangement is: this is a preference somebody changes by
 * clicking on the card in front of them, and writing it back into a YAML file
 * full of their own comments would mean the client fighting them for it. Per
 * character, because the key is the profile's filename — a healer's rail and a
 * warrior's rail are already two different instruments.
 *
 * Every field is optional and absent means *the card's own default*, never
 * `false`: a settings object written by a build that had one fewer option must
 * not silently turn that option off for everybody who already has one stored.
 */
export interface CardSettings {
  /**
   * Take the card off the rail while it has nothing to say.
   *
   * Only meaningful for the cards in `HIDES_WHEN_EMPTY`, which is also where
   * each one's default lives — absent here means *that* default, never
   * `false`. The Combat card's is `false`, which is the change todo 04 asked
   * for: it used to appear when a fight started and vanish when it ended,
   * which on a busy route is several times a minute, and every card below it
   * on the rail moved each time.
   */
  autoHide?: boolean;
  /**
   * A palette for this card alone, chosen per appearance.
   *
   * Two entries and not one, because the client's own theme is two themes:
   * pick Nord for the Combat card while the client is dark and switching the
   * client to a light theme must not leave one dark hole in a light rail. The
   * card follows whichever half matches, and follows the client where that
   * half is unset — which is every card until somebody says otherwise.
   *
   * The value is a `ThemeId` from the same registry the client's own theme
   * comes from, so a card palette is one of the sixteen already in the build
   * with its contrast asserted, rather than a second set of colours to keep
   * legible.
   */
  theme?: Partial<Record<Appearance, ThemeId>>;
  /**
   * Talk card: draw the time beside each line. On unless this says otherwise.
   *
   * The time is *recorded* either way — `Block.at` is stamped by the classifier
   * and `TalkLog` writes the whole block — so this is only about what the card
   * draws, which is why it is here and not in the character's own file.
   */
  talkStamps?: boolean;
  /** Talk card: which format that time is written in. See `TALK_STAMPS`. */
  talkStamp?: TalkStamp;
  /** Talk card: how a line's parts are arranged. See `TALK_LAYOUTS`. */
  talkLayout?: TalkLayout;
  /**
   * Talk card: carry a channel, and put it in front of what is typed.
   *
   * **Off unless this says so**, so the box sends what the player wrote. The
   * why is in `mudengine-ui` under *the Talk card sends verbatim*; what it
   * turns on is `compose` in `src/shared/talk.ts`.
   */
  talkChannels?: boolean;
  /**
   * Map card: how much of the realm to fit on it, 0 (sparse) to 1 (dense).
   *
   * A fraction rather than a room count, because what it chooses is how small
   * a room may be drawn — the count still comes from the card's own measured
   * box, so a map dragged twice as big still shows more at every setting.
   * `roomPixelsFor` is where the two ends live.
   */
  mapDensity?: number;
  /**
   * Room card, Finds face: how many days back the log is shown, `0` for all.
   *
   * A **window**, not a purge. The store is the record and keeps what it kept
   * (`FindBook`), so turning this number up brings rows back rather than
   * finding them deleted — which is the difference between a card setting and
   * a destructive one, and the reason a view preference is allowed to own it.
   */
  findDays?: number;
  /** The Combat Stats card's rate graph: hours it covers, and bars or a line (todo 08). */
  statsHours?: number;
  statsGraph?: StatsGraph;
}

/** What a card is set to when nothing has been set on it. */
export const NO_CARD_SETTINGS: CardSettings = {};

/**
 * The cards that can have nothing to say, and whether each takes itself off
 * the rail when it does.
 *
 * These five used to be five separate hard-coded answers in `cardElement` —
 * Party and Navigation hid themselves, Combat did until todo 04, and Gang and
 * Banks never did — and none of them could be changed by the person looking at
 * the rail. They are one question (*should a card that has nothing to say hold
 * its place*), so they are one setting with a per-card default: the default is
 * what each card did before, and the option is what makes the other answer
 * reachable.
 *
 * A card **absent from this table offers no such option**, because it always
 * has something true to say. That is what the settings popup builds its
 * toggle from, so a card cannot end up offering a control that does nothing.
 */
export const HIDES_WHEN_EMPTY: Partial<Record<CardId, boolean>> = {
  combat: false,
  party: true,
  navigation: true,
  gang: false,
  banks: false
};

/** Whether this card, as set for this character, leaves the rail when empty. */
export function hidesWhenEmpty(settings: CardSettings, id: CardId): boolean {
  return settings.autoHide ?? HIDES_WHEN_EMPTY[id] ?? false;
}

/**
 * Where a card is. Exactly one of these holds any given card.
 *
 * `above` and `below` are strips docked to the console rather than beside it —
 * the placement asked for in TODO.md for conversation, and the one a floating
 * card cannot give you: it does not cover the game. Rows are cheap and columns
 * are not (the console needs 80 of them), which is why the strips run
 * horizontally and the rail runs vertically.
 */
export interface CardLayout {
  rail: CardId[];
  /** Docked above the console, left to right. */
  above: CardId[];
  /** Docked below it. */
  below: CardId[];
  floats: FloatState[];
  away: CardId[];
  /**
   * What each card has been set to, for cards that have been set at all.
   *
   * Sparse on purpose, and it is deliberately **not** part of "where a card
   * is": putting a card away, floating it or dragging it somewhere else must
   * not throw away what was set on it, or every rearrangement would silently
   * undo a preference. `without` and `reset` both carry it through.
   */
  settings: Partial<Record<CardId, CardSettings>>;
  /**
   * How tall each card is on the rail, for the cards somebody has dragged
   * taller or shorter — as a **fraction of the rail's height**, never pixels,
   * the rule every float's geometry already follows and for the same reason.
   *
   * Sparse: a card with no entry is the height its stylesheet declares. A
   * rail card is a fixed box that never resizes with its contents, and this
   * is the one way its box changes — by the person looking at it, from the
   * grip in its corner.
   */
  heights: Partial<Record<CardId, number>>;
  /**
   * The cards drawn as their heading alone — name, badge and the controls that
   * fit beside them — with the body put away.
   *
   * **Placement, not preference**, which is why it sits here beside `heights`
   * rather than in `CardSettings`: it is the same act as dragging a card
   * shorter, taken to the end. So it survives every move (`without` carries
   * it, as it carries the heights) and it goes back with the arrangement when
   * `reset` is reached for — somebody untangling a rail they have rolled flat
   * expects the cards to come back open.
   *
   * A membership list rather than a record of booleans, because that is the
   * whole question: the ids in it are rolled and every other card is not.
   */
  rolled: CardId[];
}

/** The lanes a card can be docked in, as the drag machine addresses them. */
export type Lane = 'rail' | 'above' | 'below';

export interface CardLayoutApi extends CardLayout {
  isShown(id: CardId): boolean;
  /** The float for a card, if it is floating. */
  floatOf(id: CardId): FloatState | undefined;
  hide(id: CardId): void;
  show(id: CardId): void;
  /** Put a card in a lane at an index, from wherever it currently is. */
  dock(id: CardId, lane: Lane, index: number): void;
  /** Which lane holds this card, if a lane does. */
  laneOf(id: CardId): Lane | undefined;
  /**
   * Lift a card off the rail and leave it over the console.
   *
   * `size` is for a card brought out by a command rather than by a drag —
   * the loop builder, which wants more of the screen than a float ships
   * with. One call rather than a lift and a resize, because two stores in
   * one tick read the same stale layout and the second would find no float
   * to size.
   */
  lift(id: CardId, at: { x: number; y: number }, size?: { w: number; h: number }): void;
  moveFloat(id: CardId, at: { x: number; y: number }): void;
  sizeFloat(id: CardId, size: { w: number; h: number }): void;
  /** How solid the card is, 0–1. Drives both the fill and the text. */
  setSolidity(id: CardId, solidity: number): void;
  /**
   * Bring a floating card in front of the others.
   *
   * Paint order is list order, so two floats that overlap show the later one
   * on top — and a click on the visible corner of the one underneath used to
   * leave it there, undraggable until the one covering it was moved away.
   */
  raise(id: CardId): void;
  /**
   * Keep a floating card in view whichever character is shown.
   *
   * Switching characters swaps every card for the shown character's, which is
   * right — the rail is *about* that character. A pinned float is the one
   * deliberate exception: somebody watching a healer's Talk card while playing
   * the warrior has asked for exactly that.
   */
  pin(id: CardId, pinned: boolean): void;
  /** What has been set on a card. Never null: an unset card is an empty object. */
  settingsOf(id: CardId): CardSettings;
  /**
   * Change part of what is set on a card, leaving the rest of it alone.
   *
   * A patch rather than a whole object, because a settings popup writes one
   * field at a time and a caller that had to read-modify-write would be a
   * second place the merge could go wrong. A field set to `undefined` is
   * *cleared*, which is how a card goes back to its own default.
   */
  setSettings(id: CardId, change: Partial<CardSettings>): void;
  /** How tall a card was dragged on the rail, as a fraction of it, or undefined for its own height. */
  heightOf(id: CardId): number | undefined;
  /** Drag a rail card to a height, as a fraction of the rail. Clamped. */
  sizeRail(id: CardId, fraction: number): void;
  /** Back to the height the card declares for itself. */
  resetHeight(id: CardId): void;
  /** Whether this card is drawn as its heading alone. */
  isRolled(id: CardId): boolean;
  /**
   * Roll a card up to its heading, or back down to the whole card.
   *
   * Stated as the state wanted rather than as a toggle, so the control can say
   * which way it goes and two of them cannot disagree — the same reason `pin`
   * takes a boolean.
   */
  roll(id: CardId, rolled: boolean): void;
  /** Back to the shipped arrangement, for a rail that has been dragged into a corner. */
  reset(): void;
}
