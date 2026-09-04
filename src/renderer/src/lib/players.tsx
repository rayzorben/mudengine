import { keepFocus } from './focus';
import { t } from './i18n';
import type { PopoverAnchor } from './popover';
import { playerKey, type PlayerRecord } from '@shared/players';
import type { CharacterState } from '@shared/character';

/**
 * How the cards about other people phrase a sighting.
 *
 * Two cards read the same record — the Players listing, and the Player flyout
 * showing whichever of them was clicked — so a sighting is worded in one place
 * rather than in whichever of the two was edited last. Two cards that describe
 * the same fact in two different phrasings read as two different facts.
 *
 * Pure, and tested here rather than through a component, because what is
 * actually delicate is arithmetic: where the boundary between "just now" and a
 * count of minutes falls, and what a room this client could not resolve is
 * allowed to claim.
 */

/**
 * How long ago, in the coarsest unit that is still true.
 *
 * Coarse on purpose: `4m` and `4m20s` answer the same question, and the second
 * invites a reader to believe the client knows the difference. The registry
 * timestamps a *sighting*, not a position — somebody last seen four minutes ago
 * has had four minutes to walk somewhere else.
 *
 * **Five grains, and the coarsest is days.** `just now`, then tens of seconds,
 * then minutes, hours and days. Anything older than that is answered in days
 * however many there are: a sighting from March is not made more useful by
 * being called a month, and the units above a day disagree about their own
 * length in a way none of these do.
 *
 * The seconds grain exists because the first minute used to be one word.
 * `just now` covered three quarters of a minute, so a roster read while
 * somebody was walking out of the room said the same thing for forty-four
 * seconds and then jumped to `1m ago` — the one stretch where the difference
 * between five seconds and fifty actually decides whether to follow them.
 *
 * **Floored, never rounded, at every step.** Every phrase here means *at
 * least this long ago*, and rounding breaks that twice over: 55 seconds
 * rounded to the ten is `60s ago`, a phrase this scale does not have and one
 * that reads as a minute spelled wrong, and 30 hours rounded to the day is
 * `1d ago` about a sighting from yesterday morning. Flooring can only ever
 * under-state the age, which is the direction that does not invent a sighting
 * more recent than the one that happened.
 */
export function ago(at: number, now: number): string {
  // Clamped, because a record can carry a stamp from fractionally ahead of the
  // state push that draws it, and "in 2 seconds" is the readout claiming
  // something impossible.
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 10) return t('players.sighting.justNow');
  if (seconds < 60) {
    return t('players.sighting.secondsAgo', { seconds: Math.floor(seconds / 10) * 10 });
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('players.sighting.minutesAgo', { minutes });
  const hours = Math.floor(minutes / 60);
  return hours < 24
    ? t('players.sighting.hoursAgo', { hours })
    : t('players.sighting.daysAgo', { days: Math.floor(hours / 24) });
}

/**
 * Where somebody was, in words, or an admission.
 *
 * A number names nothing, so the room's name is kept at the time of the
 * sighting and preferred. Where there is no name the number is said as a
 * number and labelled as one — `room 1124` is at least something to look up,
 * where a bare `1124` reads as a quantity.
 *
 * Two admissions, not one, because they are different facts. Somebody seen
 * standing in a pitch-black room *was* seen in a room — `lastRoomAt` says when
 * — and the client simply could not say which; somebody known only from a
 * telepath has never been placed at all. Folding both into "not seen in a
 * room" would put that denial beside a "Last seen" row that names a time.
 */
export function place(record: PlayerRecord): string {
  if (record.lastRoomName !== null) return record.lastRoomName;
  if (record.lastRoom !== null) {
    return t('players.sighting.roomNumber', { roomNumber: record.lastRoom });
  }
  return record.lastRoomAt === null
    ? t('players.sighting.noRoom')
    : t('players.sighting.unplacedRoom');
}

/**
 * Every person this character has a record of, by the server's spelling —
 * the registry (offline people included: a name seen an hour ago is still a
 * name the console should recognise when it is printed again) and the roster,
 * minus this character, whose own name is not a question. Sorted, so the same
 * set is the same list and a consumer keyed on its join does not churn.
 */
export function knownPlayerNames(character: CharacterState): string[] {
  return playerNames(character, () => true);
}

/**
 * The people in the realm *now*, by the server's spelling: the online half of
 * the registry, and the roster. The console lets these outrank a realm name of
 * the same spelling and lets everybody else yield to it — see `NameIndex`.
 */
export function presentPlayerNames(character: CharacterState): string[] {
  return playerNames(character, (record) => record.online);
}

function playerNames(
  character: CharacterState,
  include: (record: PlayerRecord) => boolean
): string[] {
  const self = character.name?.toLowerCase() ?? null;
  const names = new Map<string, string>();
  for (const record of Object.values(character.players)) {
    if (include(record)) names.set(record.name.toLowerCase(), record.name);
  }
  for (const entry of character.online) names.set(entry.name.toLowerCase(), entry.name);
  if (self !== null) names.delete(self);
  return [...names.values()].sort((a, b) => a.localeCompare(b));
}

/**
 * Whether a name on a card is a person this character knows — the registry
 * or the roster — rather than a monster. The test every card asks before
 * deciding which control a name is: a person opens the Player flyout, and
 * anything else opens the realm's answer. A name nobody has listed is not a
 * person here, and gets the realm's answer, which for a stranger says the
 * realm knows nothing — never that they are safe.
 */
export function isKnownPlayer(character: CharacterState, name: string): boolean {
  const key = playerKey(name);
  if (key.length === 0) return false;
  if (key in character.players) return true;
  return character.online.some((entry) => playerKey(entry.name) === key);
}

/** Whether a name is this character's own, filed the one way every name is. */
export function isSelf(character: CharacterState, name: string): boolean {
  return character.name !== null && playerKey(character.name) === playerKey(name);
}

/**
 * Where the Player flyout hangs off: the card's edges, at the clicked row.
 *
 * The flyout is *of the card* — it slides out from the card's side, not from
 * the middle of a column — but it lines up with the row that was clicked, so
 * the eye goes from the name straight to the detail about it. So the box is
 * the card's left and right with the row's top and bottom, paired with the
 * name button as the element whose scrolling moves it: the listing's own
 * scroller contains the button, so a scroll that carries the row away closes
 * the panel, and the console printing does not (`scrollMovesAnchor`).
 *
 * A name with no card around it — there is none today — is its own anchor,
 * which is the shape `ReferencePopover` uses for every clicked item.
 */
export function flyoutAnchor(name: HTMLElement): PopoverAnchor {
  const card = name.closest<HTMLElement>('.card');
  if (card === null) return name;
  const edges = card.getBoundingClientRect();
  const row = (name.closest<HTMLElement>('tr') ?? name).getBoundingClientRect();
  return {
    box: { left: edges.left, right: edges.right, top: row.top, bottom: row.bottom },
    within: name
  };
}

/**
 * A name as the control that opens the Player flyout, shared by both listings.
 *
 * The Realm and Players cards offer the identical gesture — click a name, read
 * what the client knows — and each had grown its own copy of the button: same
 * tooltip, same `lookup` styling, same refusal to move the caret. Stated once
 * here, beside the sighting phrasing those cards also share, so the wording and
 * the focus behaviour cannot drift apart between them.
 *
 * `self` is the Realm card's own row: the listing keeps it — dropping the line
 * would be the client editing the roster — but it is not a control, because
 * `trackPlayers` files everyone *except* self and a clickable self row would
 * open a card saying "click a name". `button.lookup` because a name in a row is
 * text that happens to be clickable and must take the row's height, not a
 * control's; `keepFocus` because it is clicked and never typed into.
 */
export function PlayerName({
  name,
  className,
  onSelect,
  self = false,
  offline = false
}: {
  name: string;
  /** The owning card's cell class (`realm-name`, `player-name`); `lookup` is added here. */
  className: string;
  /** The name, and where on screen it was clicked, for the flyout to open beside. */
  onSelect(name: string, anchor: PopoverAnchor): void;
  /** This character's own row — kept in the listing, but not a control. */
  self?: boolean;
  /** Marks the row's styling; only the Players card lists people who are gone. */
  offline?: boolean;
}) {
  if (self) {
    return (
      <span className={className} title={t('cards.realm.selfTitle')}>
        {name}
      </span>
    );
  }
  return (
    <button
      className={`${className} lookup`}
      data-offline={offline ? 'true' : undefined}
      // What a press here leads to, for the flyout's click-away to leave alone.
      data-opens="player"
      onClick={(event) => onSelect(name, flyoutAnchor(event.currentTarget))}
      onMouseDown={keepFocus}
      title={t('cards.realm.nameTitle', { name })}
      type="button"
    >
      {name}
    </button>
  );
}
