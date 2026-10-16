/*
 * What a window attaching to a character is handed: the newest backscroll page
 * and every field it draws from cold. The page is asked for first and the rest
 * read after it resolves, because at launch the page waits on the startup
 * backscroll split and a field read before the wait is older than the pushes
 * the window applied during it (todo 89). See `mudengine-session`.
 */
import {
  NO_BACKSCROLL,
  type AttachSnapshot,
  type BackscrollPage,
  type BackscrollText,
  type SessionId
} from '../../shared/ipc';
import { EMPTY_CHARACTER } from '../../shared/character';
import { NO_PLAYERS } from '../../shared/players';
import { IDLE_WALK } from '../../shared/walk';
import { NO_LOOP } from '../../shared/loops';
import { EMPTY_AUTOMATION } from '../../shared/automation';
import { EMPTY_ROOM_VERDICT } from '../../shared/verdict';
import { IDLE_QUEST_RUN } from '../../shared/quests';
import { IDLE_CONNECTION } from '../../shared/types';

/** The parts of a session the snapshot reads. `SessionManager` is one. */
export interface AttachView {
  readonly lines: AttachSnapshot['lines'];
  readonly state: AttachSnapshot['state'];
  readonly character: AttachSnapshot['character'];
  readonly players: AttachSnapshot['players'];
  readonly walker: { readonly progress: AttachSnapshot['walk'] };
  readonly loops: { readonly progress: AttachSnapshot['loop'] };
  readonly automation: AttachSnapshot['automation'];
  readonly appraisal: {
    readonly verdict: AttachSnapshot['verdict'];
    readonly asks: readonly AttachSnapshot['asks'][number][];
  };
  readonly statsBaseline: { readonly base: AttachSnapshot['statsBase'] };
  readonly log: AttachSnapshot['telnet'];
  readonly learned: AttachSnapshot['learned'];
  readonly foundHere: AttachSnapshot['finds'];
  readonly questProgress: AttachSnapshot['questSaid'];
  readonly questDesk: { readonly progress: AttachSnapshot['questRun'] };
  readonly gearDesk: { readonly progress: AttachSnapshot['gearTrip'] };
}

/** A loaded character as attach sees it. `SessionSlot` is one. */
export interface AttachSlot {
  readonly manager: AttachView;
  readonly backscroll: { page(lines: number): Promise<BackscrollText> };
  /** The marks of the page's lines, read once it is in hand so none is older than a push (todo 143). */
  readonly marks: { pageOf(page: BackscrollText): BackscrollPage };
}

/** Where attach looks a character up, and what it reads beside the session. */
export interface AttachSources {
  /** Looks the session up; never creates it. */
  find(session: SessionId): AttachSlot | undefined;
  /**
   * Routes the session's live output to the attaching window. Called in the
   * same synchronous step as the page is asked for, so no chunk falls between.
   */
  register(session: SessionId): void;
  shops(session: SessionId): AttachSnapshot['shops'];
  talk(session: SessionId): AttachSnapshot['talk'];
}

export async function attachSnapshot(
  sources: AttachSources,
  session: SessionId,
  pageLines: number
): Promise<AttachSnapshot> {
  const attached = sources.find(session);
  if (attached) sources.register(session);
  const text = await attached?.backscroll.page(pageLines);
  // Looked up again: the wait can outlast the session, or the app, and a
  // session gone since must not have a talk log or shop book made for it.
  // A different slot found now belongs to a session this window never
  // registered with, or whose page this is not; the view is answered empty.
  const slot = sources.find(session) === attached ? attached : undefined;
  const manager = slot?.manager;
  return {
    backscroll: slot && text ? slot.marks.pageOf(text) : NO_BACKSCROLL,
    lines: manager?.lines ?? [],
    state: manager?.state ?? IDLE_CONNECTION,
    character: manager?.character ?? EMPTY_CHARACTER,
    players: manager?.players ?? NO_PLAYERS,
    walk: manager?.walker.progress ?? IDLE_WALK,
    loop: manager?.loops.progress ?? NO_LOOP,
    automation: manager?.automation ?? EMPTY_AUTOMATION,
    verdict: manager?.appraisal.verdict ?? EMPTY_ROOM_VERDICT,
    asks: [...(manager?.appraisal.asks ?? [])],
    statsBase: manager?.statsBaseline.base ?? null,
    telnet: manager?.log ?? [],
    learned: manager?.learned ?? [],
    finds: manager?.foundHere ?? [],
    shops: slot ? sources.shops(session) : [],
    questSaid: { ...(manager?.questProgress ?? {}) },
    questRun: manager?.questDesk.progress ?? IDLE_QUEST_RUN,
    gearTrip: manager?.gearDesk.progress ?? null,
    talk: slot ? sources.talk(session) : []
  };
}
