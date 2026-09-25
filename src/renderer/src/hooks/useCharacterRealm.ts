import { useEffect, useState } from 'react';

import type { PotionWhen } from '@shared/config';
import type { SessionId } from '@shared/ipc';
import type { BankChoice, TrainerChoice, WardRule } from '@shared/world';
import type { CharacterSection } from '../lib/characterForm';

/**
 * What the realm says about the character on the settings screen, for the
 * character form's pickers: each asked when the section drawing it opens, and
 * held here so a section left and returned to keeps what it was told. The why
 * is in `mudengine-settings`.
 */
export interface CharacterRealm {
  trainers: TrainerChoice[] | null;
  serving: Partial<Record<PotionWhen, string[]>>;
  wards: WardRule[];
  mobs: string[];
  banks: BankChoice[] | null;
}

/** The questions it asks, each addressed to the character on screen. */
export interface CharacterRealmLoaders {
  /**
   * The trainers the realm says will take a character, cheapest first.
   *
   * Addressed, because the answer is about *that* character's level and
   * class, and asked when the Train tab is opened rather than with the
   * snapshot — it is a scan of the room index, and most visits to this screen
   * are about something else.
   *
   * Empty is a real answer and the picker says so: a level the client has not
   * read, a realm built before the bands were converted, or genuinely nothing
   * in band all mean *there is nowhere to send this character*.
   */
  loadTrainers(session: SessionId): Promise<TrainerChoice[]>;
  /**
   * The bank counters this character's realm places, for the *which vault*
   * picker (todo 00). Addressed, like the trainers, because a shop row means
   * nothing across two realms.
   */
  loadBanks(session: SessionId): Promise<BankChoice[]>;
  /**
   * The items the realm says would serve each condition a potion rule can
   * name, for the rule list's suggestions. A property of the realm, so one
   * call answers every row.
   */
  loadServing(session: SessionId): Promise<Partial<Record<PotionWhen, string[]>>>;
  /**
   * The realm's own *use this item there* rules, drawn under the switch
   * that obeys them. A property of the realm, so one call answers the
   * section.
   */
  loadWards(session: SessionId): Promise<WardRule[]>;
  /**
   * The monsters this character's realm names, for the priority list's
   * picker. A property of the realm, so one call answers every row.
   */
  loadMobNames(session: SessionId): Promise<string[]>;
}

/**
 * @param active the screen is open on the characters page
 * @param section the section on screen, which decides what is asked
 * @param session the character on screen, or null while none is or one is
 *   being created, which has no realm to ask
 * @param loaders the questions, each asked with `session`
 */
export function useCharacterRealm(
  active: boolean,
  section: CharacterSection,
  session: SessionId | null,
  { loadTrainers, loadBanks, loadServing, loadWards, loadMobNames }: CharacterRealmLoaders
): CharacterRealm {
  /*
   * Where this character may go and level (todo 18).
   *
   * Asked when the Train tab is opened for an existing character, and cleared
   * when the chosen character changes so the list can never belong to
   * somebody else — the bands are per level and per class, and a picker
   * showing another character's rooms would offer walks the server refuses.
   *
   * `null` is *not asked yet* and `[]` is *nowhere*, which the picker draws
   * differently: the first is a list still loading, the second is a statement
   * about this character. The same distinction `spellbook` keeps.
   */
  const [trainers, setTrainers] = useState<TrainerChoice[] | null>(null);
  /*
   * What the realm says would serve each condition, for the potion rule
   * list's suggestions. A property of the realm and not the character, so it
   * is asked once per open rather than per row or per selection — and left as
   * an empty map where nothing answers, which the field draws as no
   * suggestions and stays typable.
   */
  const [serving, setServing] = useState<Partial<Record<PotionWhen, string[]>>>({});
  /*
   * And the realm's own rules of that same kind. Empty where no realm is
   * loaded, which draws no rows — the switch still says what it does, and
   * a realm this client holds no data for has nothing to list.
   */
  const [wards, setWards] = useState<WardRule[]>([]);
  /*
   * The monsters this character's realm names, for the priority list's picker.
   * Empty where no realm is loaded, which draws no suggestions and leaves the
   * field typable — the same rule the potion picker follows.
   */
  const [mobs, setMobs] = useState<string[]>([]);
  /*
   * The counters this character's realm places. `null` is *not asked yet*,
   * which draws no picker at all — a control offering only *any counter*
   * while the realm's answer is still coming is a control that lies about
   * what the realm holds. Asked on the Movement tab, where banking is drawn.
   */
  const [banks, setBanks] = useState<BankChoice[] | null>(null);
  useEffect(() => {
    if (!active || section !== 'train') return;
    if (session === null) {
      setTrainers([]);
      return;
    }
    let stale = false;
    setTrainers(null);
    void loadTrainers(session).then(
      (rows) => void (stale || setTrainers(rows)),
      // A list that could not be read is not a reason to refuse the save
      // somebody came here to make — the picker says nowhere, as `loadLoops`
      // says an empty shelf.
      () => void (stale || setTrainers([]))
    );
    return () => {
      stale = true;
    };
  }, [active, section, session, loadTrainers]);
  useEffect(() => {
    if (!active || section !== 'movement') return;
    if (session === null) {
      setBanks([]);
      return;
    }
    let stale = false;
    setBanks(null);
    void loadBanks(session).then(
      (rows) => void (stale || setBanks(rows)),
      // A list that could not be read is not a reason to refuse the save:
      // the picker simply is not drawn, and `bank: 0` keeps working.
      () => void (stale || setBanks([]))
    );
    return () => {
      stale = true;
    };
  }, [active, section, session, loadBanks]);
  useEffect(() => {
    if (!active || section !== 'health') return;
    if (session === null) return;
    let stale = false;
    void loadServing(session).then(
      (found) => void (stale || setServing(found)),
      () => void (stale || setServing({}))
    );
    void loadWards(session).then(
      (found) => void (stale || setWards(found)),
      // A realm that could not be read is not a reason to refuse the save:
      // no rows are drawn, exactly as no suggestions are.
      () => void (stale || setWards([]))
    );
    return () => {
      stale = true;
    };
  }, [active, section, session, loadServing, loadWards]);
  useEffect(() => {
    if (!active || section !== 'combat') return;
    if (session === null) return;
    let stale = false;
    void loadMobNames(session).then(
      (found) => void (stale || setMobs(found)),
      // A realm that could not be read is not a reason to refuse the save:
      // the field simply offers nothing and stays typable.
      () => void (stale || setMobs([]))
    );
    return () => {
      stale = true;
    };
  }, [active, section, session, loadMobNames]);
  return { trainers, serving, wards, mobs, banks };
}
