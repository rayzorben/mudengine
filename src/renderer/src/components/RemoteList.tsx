import { useMemo, useState } from 'react';

import { FindField } from './CardTable';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import {
  ACTIONABLE_REMOTES,
  isActionable,
  REMOTE_NAMES,
  REMOTES,
  type RemoteName,
  type RemoteStance
} from '@shared/remotes';

/**
 * The `@` command permission grid, in the one place it is drawn.
 *
 * Four surfaces state the same list — the Player flyout's Access face, the
 * Gang card, and the Remotes and Party sections of both settings screens — and
 * they state it in two shapes. Written once because a grid that reads one way
 * on a card and another in Settings is a permission somebody sets in the place
 * that happens to be wrong, and because the rule about which rows are
 * *toggleable* is a fact about the vocabulary rather than about a screen.
 *
 * ## All fifty-eight are shown, and only twenty-one can be set
 *
 * `REMOTE_NAMES` is MegaMUD's whole vocabulary plus this client's one peer
 * extension (`@bless-expired`). Twenty-one of them round-trip here;
 * the rest are `unread` — no capture shows the reply format, so answering would
 * mean inventing one another client then fails to parse — or `refused`, which
 * this client declines on its own account however granted (`@kill`, `@hangup`).
 *
 * The unsettable ones are **drawn and disabled with the reason beside them**
 * rather than hidden. Hiding them would make the list read as the whole
 * vocabulary while silently being a fifth of it, and somebody looking for
 * `@goto` would conclude the client had never heard of it. Disabled with
 * *no capture shows a reply* beside it says the true thing: this is known, and
 * it is not answerable yet.
 *
 * **Allow all means all the settable ones**, which is `ACTIONABLE_REMOTES`. It
 * writes the names out rather than storing a wildcard, so a later build that
 * makes `@goto` answerable does not silently hand it to everybody who once
 * pressed a button — the safe direction for a permission is the one that grants
 * less, and a list is auditable in the user's own YAML in a way `*` is not.
 *
 * ## Two shapes, because two questions
 *
 * - `player` — three states per remote. Allow, deny, or neither; neither falls
 *   through to the gang and then the party, which is why the row says where an
 *   unset one lands, and which of the two it landed on.
 *   Deny exists so *"the gang, except Rend"* is expressible at all.
 * - `gang` and `party` — two states. On or off, for anybody in this
 *   character's gang, or for anybody who has joined its party. One shape and
 *   two modes rather than one mode called `group`: the two write different
 *   keys, say different things in a button's title, and `data-mode` is what a
 *   style or a test reaches for to tell one grid from the other.
 *
 * ## It is a list and not a `CardTable`
 *
 * The table rules are for a listing whose length the player does not control
 * and which has a dimension worth cutting by. This is fifty-eight rows of
 * *controls*, fixed while the vocabulary is, and the only dimension — support — is already
 * carried on each row as the reason it cannot be set. What it does borrow is
 * the find field, because fifty-eight rows is more than anybody reads down, and
 * the `n of m` line that a narrowed listing owes the reader.
 */
export type RemoteListMode = 'player' | 'gang' | 'party';

export interface RemoteListProps {
  mode: RemoteListMode;
  /** Whose permissions these are, for the button titles. The gang's name in `gang` mode. */
  subject: string;
  /** Remotes explicitly allowed. In `gang` and `party` mode this is the whole of the state. */
  allow: readonly RemoteName[];
  /** Remotes explicitly denied. Empty and unused in `gang` and `party` mode. */
  deny?: readonly RemoteName[];
  /**
   * What the gang grants, so a `player` row can say where an unset one lands.
   * Absent in the two-state modes, where the list itself is that answer.
   */
  fromGang?: readonly RemoteName[];
  /**
   * What the party grants, and only passed for somebody who has **joined**
   * this character's party — the chip states the live picture the way the
   * flyout's header does, so an unset row on a stranger must not read as
   * granted because the party list happens to carry the command.
   */
  fromParty?: readonly RemoteName[];
  /** One remote changed. The two-state modes never send `deny`. */
  onSet(remote: RemoteName, stance: RemoteStance): void;
  /** Every settable remote at once, on or off. Its own callback so one write can do it. */
  onSetAll(stance: 'allow' | 'unset'): void;
  /** Hands the caret back to the game when the find field is left. */
  returnFocus?(): void;
}

export default function RemoteList({
  mode,
  subject,
  allow,
  deny = [],
  fromGang,
  fromParty,
  onSet,
  onSetAll,
  returnFocus
}: RemoteListProps) {
  const [query, setQuery] = useState('');

  const allowed = useMemo(() => new Set(allow), [allow]);
  const denied = useMemo(() => new Set(deny), [deny]);
  const gang = useMemo(() => new Set(fromGang ?? []), [fromGang]);
  const party = useMemo(() => new Set(fromParty ?? []), [fromParty]);

  /*
   * Matched on the name as it is spoken — `@` and all — because that is what
   * somebody types when they are looking for one. Every term, from anywhere in
   * the name, the same reading `lib/table.ts` gives a two-word query.
   */
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = REMOTE_NAMES.filter((name) => terms.every((term) => `@${name}`.includes(term)));

  const granted = ACTIONABLE_REMOTES.filter((name) => allowed.has(name)).length;

  return (
    <div className="remote-list" data-mode={mode}>
      <div className="remote-list-tools">
        <FindField
          label={t('remotes.findPlaceholder')}
          onChange={setQuery}
          query={query}
          returnFocus={returnFocus}
        />
        <div className="remote-list-bulk">
          {/*
            Both halves, always: "allow all" without a way back is a button
            people are afraid to press. Clear takes the denies off too, because
            "clear" that left half the state behind is the mode this grid has
            no room for.
          */}
          <button
            className="chip toggle"
            onClick={() => onSetAll('allow')}
            onMouseDown={keepFocus}
            title={t('remotes.allowAllTitle')}
            type="button"
          >
            {t('remotes.allowAll')}
          </button>
          <button
            className="chip toggle"
            onClick={() => onSetAll('unset')}
            onMouseDown={keepFocus}
            title={t('remotes.clearAllTitle')}
            type="button"
          >
            {t('remotes.clearAll')}
          </button>
        </div>
      </div>

      <p className="remote-list-count">
        {t('remotes.granted', { granted, total: ACTIONABLE_REMOTES.length })}
        {/*
          A narrowed list says so and says how to undo it, the rule every card
          table keeps — and not before anything is hidden.
        */}
        {shown.length === REMOTE_NAMES.length ? null : (
          <>
            {' · '}
            {t('remotes.showing', { shown: shown.length, total: REMOTE_NAMES.length })}{' '}
            <button className="linkish" onClick={() => setQuery('')} type="button">
              {t('remotes.showAll')}
            </button>
          </>
        )}
      </p>

      {shown.length === 0 ? (
        <p className="empty">{t('remotes.noMatch', { query })}</p>
      ) : (
        <ul className="remote-rows">
          {shown.map((name) => {
            const spec = REMOTES[name];
            const settable = isActionable(name);
            const on = allowed.has(name);
            const off = denied.has(name);
            return (
              <li data-settable={settable ? 'true' : 'false'} key={name}>
                <span className="remote-name">@{name}</span>
                {!settable ? (
                  <span
                    className="quiet-note"
                    title={
                      spec.support === 'unread'
                        ? t('remotes.support.unreadTitle', { because: spec.because })
                        : t('remotes.support.refusedTitle')
                    }
                  >
                    {spec.support === 'unread'
                      ? t('remotes.support.unread')
                      : t('remotes.support.refused')}
                  </span>
                ) : mode !== 'player' ? (
                  <button
                    aria-pressed={on}
                    className="chip toggle"
                    data-level="ok"
                    data-on={on ? 'true' : 'false'}
                    onClick={() => onSet(name, on ? 'unset' : 'allow')}
                    onMouseDown={keepFocus}
                    title={
                      mode === 'party'
                        ? t('remotes.onPartyTitle', { remote: name })
                        : t('remotes.onTitle', { remote: name })
                    }
                    type="button"
                  >
                    {t('remotes.on')}
                  </button>
                ) : (
                  <span className="remote-stance">
                    {/*
                      Two chips rather than three buttons or a cycling one.
                      Neither pressed is `unset`, which is what nearly every
                      pair is; a cycle would make the state depend on how many
                      times somebody clicked, which is the one thing a
                      permission control must never do.
                    */}
                    <button
                      aria-pressed={on}
                      className="chip toggle"
                      data-level="ok"
                      data-on={on ? 'true' : 'false'}
                      onClick={() => onSet(name, on ? 'unset' : 'allow')}
                      onMouseDown={keepFocus}
                      title={t('remotes.allowTitle', { remote: name, name: subject })}
                      type="button"
                    >
                      {t('remotes.allow')}
                    </button>
                    <button
                      aria-pressed={off}
                      className="chip toggle"
                      data-level="critical"
                      data-on={off ? 'true' : 'false'}
                      onClick={() => onSet(name, off ? 'unset' : 'deny')}
                      onMouseDown={keepFocus}
                      title={t('remotes.denyTitle', { remote: name, name: subject })}
                      type="button"
                    >
                      {t('remotes.deny')}
                    </button>
                    {/*
                      Where an unset row lands. Only when it actually lands
                      somewhere: a note saying "nothing" on fifty rows is a
                      column of noise, and the count above already says how
                      much is granted.
                    */}
                    {!on && !off && gang.has(name) ? (
                      <span className="chip">{t('remotes.fromGang')}</span>
                    ) : !on && !off && party.has(name) ? (
                      <span className="chip">{t('remotes.fromParty')}</span>
                    ) : null}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
