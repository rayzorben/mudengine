/**
 * The Loops modal: whether it is open, closing it (which hands the caret
 * back), and what it lists — the shipped shelf, fetched the first time it
 * opens, beside this character's own loops, grouped by where it stands.
 *
 * Out of `App` (todo 732) with the state it owns. See `mudengine-ui` ›
 * *Focus lives in the terminal*.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { t } from '../lib/i18n';
import { loopRows, type HeldLoop, type LoopHere, type LoopRow } from '../lib/loops';
import type { CharacterState } from '@shared/character';
import { NO_SESSION, type IpcApi, type SessionId } from '@shared/ipc';
import type { Loop } from '@shared/loops';

export interface LoopsModalState {
  open: boolean;
  toggle(): void;
  close(): void;
  /** True until the shelf has arrived. */
  loading: boolean;
  /** The shelf and this character's own, as the rows the modal draws. */
  rows: LoopRow[];
  here: LoopHere;
}

export interface LoopsModalInputs {
  api: Pick<IpcApi, 'loopCatalogue'>;
  /** The character the modal is for: the shown one, or `NO_SESSION`. */
  session: SessionId;
  /** This character's own loops, as `loop:list` answers them. */
  loops: readonly HeldLoop[];
  /** The last loop this character walked (`view.loop.name`). */
  recent: string | null;
  room: CharacterState['room'];
  returnFocus(): void;
  /** A sentence into one character's console. */
  say(session: SessionId, message: string): void;
}

export function useLoopsModal({
  api,
  session,
  loops,
  recent,
  room,
  returnFocus,
  say
}: LoopsModalInputs): LoopsModalState {
  /*
   * A plain `useState`, deliberately not a remembered preference: it is a
   * thing reached for, used and put down — the shape the diagnostics rail
   * settled on — and a modal that reopened itself on every launch because
   * somebody once looked at it is chrome nobody asked for.
   */
  const [open, setOpen] = useState(false);

  /*
   * It holds the caret while it is open and hands it back on every exit — a
   * surface that takes typed input, like the palette, and unlike the
   * diagnostics rail.
   */
  const close = useCallback(() => {
    setOpen(false);
    returnFocus();
  }, [returnFocus]);

  /*
   * Only for a character that exists.
   *
   * Everything the modal does is addressed at one: it files into that
   * character's scope, starts a loop on its session and reports a refusal into
   * its console. With `NO_SESSION` there is no console for the refusal to
   * reach, so the whole gesture would fail in silence — which is the one
   * outcome "say it out loud" forbids. A client with no characters has one
   * job, and it is not this.
   */
  const toggle = useCallback(() => {
    if (open) close();
    else if (session !== NO_SESSION) setOpen(true);
  }, [open, close, session]);

  /*
   * And it goes away if the character does while it is open.
   *
   * Guarding only the *opening* leaves the modal up when the last tab is
   * closed or a profile file is deleted — `session` becomes `NO_SESSION`
   * underneath it, and every row then addresses nobody. Nothing is written
   * wrongly (main refuses an absent owner, and `startLoop` finds no session),
   * but the refusals are spoken into a console that does not exist, so a click
   * would do nothing and say nothing. A guard on entry and none on the state
   * is half a rule.
   */
  useEffect(() => {
    if (open && session === NO_SESSION) close();
  }, [open, session, close]);

  /*
   * The shipped shelf, fetched the first time the modal is opened and kept.
   *
   * Not at launch: it is four hundred and twenty loops, and most sessions
   * never open this — the same reason the settings screen asks for it on the
   * Movement tab rather than carrying it in the snapshot. Kept afterwards
   * because the file is inside the application and changes only when the
   * application does, which is `LoopCatalogue`'s own reason for reading it
   * once.
   */
  const [catalogue, setCatalogue] = useState<Loop[] | null>(null);
  useEffect(() => {
    if (!open || catalogue !== null) return;
    let stale = false;
    void api
      .loopCatalogue()
      .then((list) => {
        if (!stale) setCatalogue(list);
      })
      .catch((error: unknown) => {
        /*
         * An empty shelf, said out loud, rather than "Reading the loops…" for
         * ever. `LoopCatalogue` already answers a missing file with an empty
         * list, so reaching here means the call itself failed — and a modal
         * left spinning is a feature that looks broken with nothing anywhere
         * saying why. The character's own loops are still listed, which is
         * what makes an empty shelf usable rather than fatal.
         */
        if (stale) return;
        setCatalogue([]);
        say(session, t('loops.catalogueFailed', { reason: String(error) }));
      });
    return () => {
      stale = true;
    };
  }, [api, open, catalogue, session, say]);

  /*
   * Memoised on both, so a status line republishing `character` does not
   * rebuild four hundred rows — the reason `phasesKey` is memoised on its own
   * beside the palette's commands.
   */
  const rows = useMemo(() => loopRows(catalogue ?? [], loops), [catalogue, loops]);

  /*
   * Where this character is, for the sections the modal draws above the areas.
   *
   * `recent` outlives the run it named — `stopped` keeps it, which is the same
   * reason the Navigation card's Loop face keeps showing a loop after it has
   * ended — so this is *the last loop walked*, not *the loop running*, which
   * is the one somebody reaching for this modal most often wants back. Null
   * before a session has run one, and the section is then simply absent.
   *
   * The room is taken from the tracker as it stands: the name the server
   * printed and the coordinates the client resolved, each independently null.
   * Neither is repaired here — a room the client has not placed matches no
   * stop, which is right, because "I do not know where you are" must not come
   * out as "every loop starts here". Memoised on the three values rather than
   * on the room, so a status line arriving twice a second does not re-group
   * four hundred rows.
   */
  const here = useMemo<LoopHere>(
    () => ({
      recent,
      roomName: room.name,
      at: room.map === null || room.number === null ? null : { map: room.map, room: room.number }
    }),
    [recent, room.name, room.map, room.number]
  );

  return { open, toggle, close, loading: catalogue === null, rows, here };
}
