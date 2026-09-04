import { flyoutAnchor, isSelf } from './players';
import { t } from './i18n';
import type { PopoverAnchor } from './popover';
import { ownGang, type CharacterState } from '@shared/character';
import { playerKey, type PlayerRecord } from '@shared/players';

/**
 * A gang is an entity, and this is what the client knows about one.
 *
 * The membership assembly lived inside `GangCard`, which could only ever ask it
 * about **this character's own** gang. A gang printed in a `who` listing is a
 * thing a person points at and asks about — the same question they ask of an
 * item, a monster or another player — and answering it from a second copy of
 * this arithmetic would mean the card and the flyout disagreeing about who is
 * in a gang, which is the failure this project already has a name for.
 *
 * So the assembly is here, taking the gang as an argument, and the card asks it
 * about `ownGang(character)` like anybody else.
 *
 * Pure, and tested here rather than through a component, because what is
 * delicate is the merge: two sources that each know half of the answer, one of
 * which does not file this character at all.
 */

/**
 * One row of a gang's membership: what a listing said, plus who is here.
 *
 * Assembled from two sources that answer different halves of the question, and
 * kept as one row so a table has one shape whichever source knows a member.
 */
export interface Member {
  name: string;
  online: boolean;
  level: number | null;
  race: string | null;
  className: string | null;
  /** `Leader`, `Captain`, `Lieutenant` — the listing's own word, or null. */
  rank: string | null;
  /** True where the roster has them and no gang listing has covered them. */
  rosterOnly: boolean;
  /**
   * This character's own row. Kept, because a gang of two that draws one
   * member is a listing the card edited — and when this character is the
   * leader, the star is missing from the one row that carries it. Its name is
   * text rather than a control, per the listings' own rule: a flyout about
   * yourself would say nothing the rail is not already saying.
   */
  self: boolean;
}

/**
 * Everybody known to be in one gang, from the two sources that know one.
 *
 * The registry is the lead: a `bg` listing writes a level, a race, a class and
 * — crucially — an `online: false` for the members `who` cannot mention at all.
 * The roster fills in anybody standing in the realm right now whom no listing
 * has covered yet, so the answer is useful before any button is pressed rather
 * than empty until it is.
 *
 * **This character is one of the members**, where the gang is its own. It was
 * excluded once on the reasoning that it cannot send itself an `@` command —
 * true of the *grant* and wrong about the membership. `Valor members (2)` drawn
 * as a single row is a card contradicting the listing above it, and the row
 * dropped is the one most likely to carry `[Leader]`.
 *
 * Case-insensitively throughout, because a gang name is typed by whoever
 * founded it and the server is inconsistent about case.
 */
export function membersOf(character: CharacterState, gang: string): Member[] {
  const wanted = gang.trim().toLowerCase();
  if (wanted.length === 0) return [];
  const rows = new Map<string, Member>();

  for (const record of Object.values(character.players)) {
    if (record.gang === null || record.gang.toLowerCase() !== wanted) continue;
    rows.set(playerKey(record.name), {
      ...fromRecord(record),
      self: isSelf(character, record.name)
    });
  }

  for (const entry of character.online) {
    if (entry.gang === null || entry.gang.toLowerCase() !== wanted) continue;
    const key = playerKey(entry.name);
    const known = rows.get(key);
    /*
     * The roster is authoritative about presence and silent about the rest.
     * Somebody the registry has as offline who is standing in the realm now is
     * online — the roster is the fresher of the two on that one field — and
     * everything a listing established is kept.
     */
    if (known) rows.set(key, { ...known, online: true });
    else
      rows.set(key, {
        name: entry.name,
        online: true,
        level: null,
        race: null,
        className: null,
        rank: null,
        rosterOnly: true,
        self: isSelf(character, entry.name)
      });
  }

  /*
   * The roster carries this character's own row and the registry does not file
   * it (`trackPlayers` files everybody *except* self), so until a `bg` is
   * pressed the loops above find it only in `character.online` — and not at all
   * while offline. A character in a gang that nothing has listed is still a
   * member of it, and a card that waits for the button to admit the reader
   * exists is the same empty-until-asked failure the roster fallback exists to
   * prevent.
   *
   * Only for this character's *own* gang: adding its row to somebody else's
   * would be the client asserting a membership nothing said.
   */
  const own = ownGang(character);
  const isOwn = typeof own === 'string' && own.toLowerCase() === wanted;
  if (isOwn && character.name !== null && !rows.has(playerKey(character.name))) {
    rows.set(playerKey(character.name), {
      name: character.name,
      online: character.phase === 'in-game',
      level: character.progress.level,
      race: character.race,
      className: character.className,
      rank: null,
      rosterOnly: true,
      self: true
    });
  }

  return [...rows.values()].sort(order);
}

/**
 * Every gang this character has heard of, by the spelling last printed.
 *
 * The roster and the registry, folded case-insensitively because a gang name is
 * typed by whoever founded it: `Valor` and `valor` are one gang, and the
 * console must not offer two links for them. The later spelling wins, which is
 * the fresher of the two.
 *
 * This character's own gang is included: it is a gang like any other, and the
 * one whose name is printed most often.
 */
export function knownGangs(character: CharacterState): string[] {
  const found = new Map<string, string>();
  const note = (name: string | null | undefined): void => {
    if (typeof name !== 'string') return;
    const gang = name.trim();
    if (gang.length === 0) return;
    found.set(gang.toLowerCase(), gang);
  };

  for (const record of Object.values(character.players)) note(record.gang);
  for (const entry of character.online) note(entry.gang);
  const own = ownGang(character);
  if (typeof own === 'string') note(own);

  return [...found.values()].sort((a, b) => a.localeCompare(b));
}

function fromRecord(record: PlayerRecord): Member {
  return {
    name: record.name,
    online: record.online,
    level: record.level,
    race: record.race,
    className: record.className,
    rank: record.gangRank,
    /*
     * Whether a gang listing has spoken about *this* person, taken from the
     * rank field rather than inferred from the other three being null: a row
     * the pattern dropped and `who` later filled in would read as listed on an
     * absence-of-facts test, and a note claiming a provenance the row does not
     * have is worse than no note.
     */
    rosterOnly: record.gangRank === null && record.level === null,
    /* Set by the caller, which is the only side that knows who is reading. */
    self: false
  };
}

/**
 * Online first, then by name.
 *
 * Who is on is the question a gang is looked up for, so they belong where the
 * eye lands — the same decision `knownPlayers` makes for the registry and the
 * Realm card makes for standing. By name within each group rather than by
 * level, so a member does not appear to move between listings because they
 * levelled.
 */
function order(a: Member, b: Member): number {
  if (a.online !== b.online) return a.online ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/**
 * A gang's name, as a control.
 *
 * A gang is an entity, so it is clickable wherever it is printed — the rule
 * `PlayerName` states for a person, applied to the other thing a `who` row
 * names. Anchored the same way, through the same helper, so a gang clicked on
 * a listing and a person clicked beside it open panels in the same place.
 *
 * `data-opens` marks it for the flyouts' click-away, which leaves a press on
 * anything that *opens* a panel to its own click rather than dismissing first
 * and re-opening on the click behind it.
 */
export function GangName({
  gang,
  className,
  onSelect
}: {
  gang: string;
  /** The owning surface's cell class; `lookup` is added here. */
  className: string;
  onSelect(gang: string, anchor: PopoverAnchor): void;
}) {
  return (
    <button
      className={`${className} lookup`}
      data-opens="gang"
      onClick={(event) => onSelect(gang, flyoutAnchor(event.currentTarget))}
      title={t('cards.gangDetail.openTooltip', { gang })}
      type="button"
    >
      {gang}
    </button>
  );
}
