import { useState } from 'react';
import { TextField } from './FormField';
import RemoteList from './RemoteList';

import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import { ACTIONABLE_REMOTES, type RemoteGrant } from '@shared/remotes';

/**
 * The per-player half of `automation.remotes`, edited from a form.
 *
 * The Player flyout is the surface most people use, and it can only be opened
 * on somebody the client has **seen** — a name in a room, on a `who`, in a
 * telepath. That is the wrong constraint for setting a pair of characters up
 * before either has logged in, which is the ordinary case for the person
 * running four of them. So the same grid is here, addressed by a typed name.
 *
 * **One person at a time.** A form showing every named player's fifty-seven
 * rows at once would be a wall nobody reads; the names are chips, and choosing
 * one opens that person's grid. Somebody with nothing granted is not kept — an
 * empty grant is the absence of a decision, and a list that accumulated a name
 * per click would read as a list of people with permissions when it holds
 * people with none.
 */
export default function PlayerGrants({
  grants,
  onChange
}: {
  grants: Record<string, RemoteGrant>;
  onChange(next: Record<string, RemoteGrant>): void;
}) {
  const names = Object.keys(grants).sort();
  const [chosen, setChosen] = useState<string | null>(null);
  const [typed, setTyped] = useState('');

  const who = chosen !== null && chosen in grants ? chosen : (names[0] ?? null);
  const grant = who === null ? null : grants[who]!;

  const write = (key: string, next: RemoteGrant): void => {
    const rest = { ...grants };
    // An emptied grant is removed, exactly as `SettingsEditor` removes it from
    // the file: two places that disagreed about what "nothing" looks like would
    // leave a name in the form that vanished on the next load.
    if (next.allow.length === 0 && next.deny.length === 0) delete rest[key];
    else rest[key] = next;
    onChange(rest);
  };

  return (
    <div className="remote-players">
      <TextField
        hint={t('settings.remotes.addPlayerHint')}
        label={t('settings.remotes.addPlayerLabel')}
        name="remotes-add-player"
        onChange={setTyped}
        onSubmit={() => {
          const key = typed.trim().toLowerCase();
          if (key.length === 0) return;
          setTyped('');
          setChosen(key);
          // Created empty and kept only once something is granted, so a name
          // typed by mistake leaves nothing behind.
          if (!(key in grants)) onChange({ ...grants, [key]: { allow: [], deny: [] } });
        }}
        placeholder={t('settings.remotes.addPlayerPlaceholder')}
        spellCheck={false}
        value={typed}
      />

      {names.length === 0 ? null : (
        <div className="settings-chips" role="group">
          {names.map((name) => (
            <button
              aria-pressed={name === who}
              className="chip toggle"
              data-on={name === who ? 'true' : 'false'}
              key={name}
              onClick={() => setChosen(name)}
              onMouseDown={keepFocus}
              type="button"
            >
              {name}
            </button>
          ))}
        </div>
      )}

      {who === null || grant === null ? null : (
        <>
          <h4 className="settings-subhead">
            {t('settings.remotes.playerLegend', { name: who })}
            <button
              className="chip toggle"
              data-level="critical"
              onClick={() => write(who, { allow: [], deny: [] })}
              onMouseDown={keepFocus}
              title={t('settings.remotes.removePlayerTitle', { name: who })}
              type="button"
            >
              {t('settings.remotes.removePlayer')}
            </button>
          </h4>
          <RemoteList
            allow={grant.allow}
            deny={grant.deny}
            mode="player"
            onSet={(remote, stance) =>
              write(who, {
                allow:
                  stance === 'allow'
                    ? [...grant.allow, remote]
                    : grant.allow.filter((entry) => entry !== remote),
                deny:
                  stance === 'deny'
                    ? [...grant.deny, remote]
                    : grant.deny.filter((entry) => entry !== remote)
              })
            }
            onSetAll={(stance) =>
              write(
                who,
                stance === 'allow'
                  ? { allow: [...ACTIONABLE_REMOTES], deny: [] }
                  : { allow: [], deny: [] }
              )
            }
            subject={who}
          />
        </>
      )}
    </div>
  );
}
