/**
 * The loop builder: bringing it out, a loop the Hunting card drew handed to
 * it as a seed, and the calls it plans and files with, addressed at the shown
 * character — it plans on that realm and files into that scope.
 *
 * Out of `App` (todo 733). See `mudengine-ui` › `parts/map.md`.
 */
import { useCallback, useMemo, useState } from 'react';

import type { BuilderDestination, BuilderSeed } from '../components/LoopBuilderCard';
import type { CardLayoutApi } from '../lib/cards';
import { t } from '../lib/i18n';
import { loopOwner } from '../lib/loops';
import type { HuntingRoom } from '@shared/hunting';
import { NO_SESSION, type IpcApi, type ProfileSummary, type SessionId } from '@shared/ipc';
import type { Loop } from '@shared/loops';
import type { LocalMap } from '@shared/map';
import type { LoopDraft, RoomId, WorldRoom } from '@shared/world';

/** What the loop builder needs of the client, built once per character and kept. */
export interface BuilderApi {
  characterName: string;
  realmName: string;
  search(query: string): Promise<WorldRoom[]>;
  loadMap(map: number, room: number, radius: number): Promise<LocalMap>;
  draft(rooms: RoomId[]): Promise<LoopDraft>;
  save(loop: Loop, destination: BuilderDestination): Promise<string | null>;
  /** A loop to open drawn — the Hunting card's — or null for an empty map. */
  seed: BuilderSeed | null;
}

export interface LoopBuilderInputs {
  api: Pick<IpcApi, 'draftLoop' | 'addLoop'>;
  /** The character on screen, or `NO_SESSION`. */
  session: SessionId;
  profiles: readonly Pick<ProfileSummary, 'id' | 'serverName'>[];
  /** The shown character's arrangement, where the builder is brought out. */
  cards: Pick<CardLayoutApi, 'isShown' | 'lift' | 'floatOf' | 'raise'>;
  /** The name the realm knows the character by, once the sheet has said. */
  characterName: string | null;
  search: BuilderApi['search'];
  loadMap: BuilderApi['loadMap'];
  returnFocus(): void;
  /** A sentence into one character's console. */
  say(session: SessionId, message: string): void;
}

export interface LoopBuilder {
  openBuilder(): void;
  /** Opens the builder on a loop the Hunting card drew, named. */
  createHunt(rooms: HuntingRoom[], name: string): void;
  builderApi: BuilderApi;
}

export function useLoopBuilder({
  api,
  session,
  profiles,
  cards,
  characterName,
  search: searchRooms,
  loadMap,
  returnFocus,
  say
}: LoopBuilderInputs): LoopBuilder {
  /**
   * Bring the loop builder out.
   *
   * As a **float**, sized to most of the workspace, the first time: a map
   * somebody clicks rooms on wants more of the screen than a rail slot, and
   * the float is the one placement whose height is the player's. Already on
   * screen, it is raised if floating and otherwise left where the player put
   * it — the arrangement is theirs. Refused with no character, for the
   * reason the Loops modal is: everything it does is addressed at one.
   */
  const openBuilder = useCallback(() => {
    if (session === NO_SESSION) return;
    if (!cards.isShown('builder')) cards.lift('builder', { x: 0.03, y: 0.04 }, { w: 0.6, h: 0.9 });
    else if (cards.floatOf('builder') !== undefined) cards.raise('builder');
    returnFocus();
  }, [cards, returnFocus, session]);

  /*
   * A loop the Hunting card drew, handed to the builder as picks closed on
   * the first room, with its name offered (todo 00, 2026-09-13). The seed is
   * a request and not a state of the builder: the card takes it once, and
   * from there the picks are its own to edit, undo and file.
   */
  const [builderSeed, setBuilderSeed] = useState<BuilderSeed | null>(null);
  const createHunt = useCallback(
    (rooms: HuntingRoom[], name: string) => {
      const ids = rooms.map((room) => room.id);
      const first = ids[0];
      if (first === undefined || ids.length < 2) return;
      setBuilderSeed({ picks: [...ids, first], name, stamp: Date.now() });
      openBuilder();
    },
    [openBuilder]
  );

  /**
   * The picks of a loop being built, planned on this character's realm.
   * Addressed like every world query.
   */
  const draftLoop = useCallback((rooms: RoomId[]) => api.draftLoop(session, rooms), [api, session]);

  /**
   * File a built loop where the builder's chip says, and say so in the
   * character's own console — the rule `runChosenLoop` keeps for a loop the
   * shelf files, under the owner the modal files under (`loopOwner`).
   */
  const saveDraftLoop = useCallback(
    async (loop: Loop, destination: BuilderDestination): Promise<string | null> => {
      const refused = await api.addLoop(
        destination,
        loopOwner(destination, session, profiles),
        loop
      );
      if (refused === null) say(session, t('cards.builder.savedNotice', { loopName: loop.name }));
      return refused;
    },
    [api, profiles, say, session]
  );

  const builderRealmName = profiles.find((profile) => profile.id === session)?.serverName ?? '';
  const builderCharacterName = characterName ?? session;
  const builderApi = useMemo<BuilderApi>(
    () => ({
      characterName: builderCharacterName,
      realmName: builderRealmName,
      search: searchRooms,
      loadMap,
      draft: draftLoop,
      save: saveDraftLoop,
      seed: builderSeed
    }),
    [
      builderCharacterName,
      builderRealmName,
      searchRooms,
      loadMap,
      draftLoop,
      saveDraftLoop,
      builderSeed
    ]
  );

  return { openBuilder, createHunt, builderApi };
}
