import { useState } from 'react';

import { CheckField } from './FormField';
import SharePrompt, { type ShareAsked } from './SharePrompt';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import { withPinnedKey } from '@shared/peerGrant';
import { keyFingerprint, type KeyOffer, type ShareView } from '@shared/peers';
import { MOST_SHARE_KEYS } from '@shared/peerWire';
import { playerKey } from '@shared/players';
import type { RemoteGrant } from '@shared/remotes';

export interface PlayerSharingProps {
  /** The character whose Access face this is; null before the realm has named it. */
  character: string | null;
  /** The player the row is about. */
  player: string;
  grant: RemoteGrant;
  set(next: RemoteGrant): void;
  shares: ShareView;
  /** The prompt opened or closed: while it is open, Escape is its own. */
  onAsking(open: boolean): void;
}

/**
 * Sharing on a player's Access face (todo 20261031-1156-01): share this
 * character with them, behind `SharePrompt`; show what they share with it;
 * and the keys the sharing server saw claim their name, each confirmed by
 * this player's press after comparing it with what they read out. Nothing is
 * sent to or shown from a key that is not confirmed here, since anybody can
 * claim a name. This character's own key is shown for them to compare.
 */
export default function PlayerSharing({
  character,
  player,
  grant,
  set,
  shares,
  onAsking
}: PlayerSharingProps): React.JSX.Element {
  const [asked, setAskedState] = useState<ShareAsked | null>(null);
  const setAsked = (next: ShareAsked | null): void => {
    setAskedState(next);
    onAsking(next !== null);
  };
  const theirs = (offer: KeyOffer): boolean => playerKey(offer.name) === playerKey(player);
  // A claim the gateway reported, or a share offered, under a key not yet confirmed; each key once.
  const waiting = [...shares.unpinned, ...shares.offered]
    .filter(theirs)
    .filter((offer, at, all) => all.findIndex((each) => each.key === offer.key) === at);
  const full = grant.keys.length >= MOST_SHARE_KEYS;
  const sheet = shares.sheets.find((each) => playerKey(each.from.name) === playerKey(player));

  return (
    <div className="player-sharing" data-sharing={shares.enabled ? 'on' : 'off'}>
      <div className="settings-inline">
        {/* Not offered before the realm has named this character: the prompt says whose it is. */}
        {(character !== null || grant.share !== 'off') && (
          <CheckField
            checked={grant.share !== 'off'}
            hint={t('cards.player.share.shareHint')}
            label={t('cards.player.share.share')}
            name="player-share"
            onChange={(on) => {
              if (on && character !== null) setAsked({ character, player, control: false });
              else set({ ...grant, share: 'off' });
            }}
          />
        )}
        {/* Raising a share asks again; lowering it ends control at once. */}
        {grant.share !== 'off' && (
          <CheckField
            checked={grant.share === 'control'}
            hint={t('cards.player.share.controlHint')}
            label={t('cards.player.share.control')}
            name="player-control"
            onChange={(on) => {
              if (on && character !== null) setAsked({ character, player, control: true });
              else set({ ...grant, share: 'state' });
            }}
          />
        )}
        <CheckField
          checked={grant.receive}
          hint={t('cards.player.share.receiveHint')}
          label={t('cards.player.share.receive')}
          name="player-receive"
          onChange={(on) => set({ ...grant, receive: on })}
        />
      </div>
      {!shares.enabled && (grant.share !== 'off' || grant.receive) && (
        <p className="settings-warn">{t('cards.player.share.offWarning')}</p>
      )}
      {shares.ownKey !== null && (
        <p className="settings-note" data-own-key>
          {t('cards.player.share.ownKey', { key: keyFingerprint(shares.ownKey) })}
        </p>
      )}
      {waiting.map((offer) => (
        <div className="settings-control-row" data-key-offer={offer.key} key={offer.key}>
          <span>
            {t('cards.player.share.claimed', { name: offer.name, key: keyFingerprint(offer.key) })}
          </span>
          <button
            className="quiet"
            disabled={full}
            onClick={() => set({ ...grant, ...withPinnedKey(grant, offer.key) })}
            onMouseDown={keepFocus}
            type="button"
          >
            {t('cards.player.share.confirm')}
          </button>
        </div>
      ))}
      {full && waiting.length > 0 && (
        <p className="settings-warn">
          {t('cards.player.share.keysFull', { most: MOST_SHARE_KEYS })}
        </p>
      )}
      {grant.keys.map((key) => (
        <div className="settings-control-row" data-pinned-key={key} key={key}>
          <span>{t('cards.player.share.pinned', { key: keyFingerprint(key) })}</span>
          <button
            className="quiet"
            onClick={() => set({ ...grant, keys: grant.keys.filter((each) => each !== key) })}
            onMouseDown={keepFocus}
            type="button"
          >
            {t('cards.player.share.forget')}
          </button>
        </div>
      ))}
      {grant.share !== 'off' && grant.keys.length === 0 && waiting.length === 0 && (
        <p className="quiet-note">{t('cards.player.share.noKey', { name: player })}</p>
      )}
      {sheet !== undefined && (
        <p className="settings-note" data-shared-sheet>
          {t('cards.player.share.hearing', {
            name: sheet.from.name,
            hp: sheet.sheet.vitals?.hp?.toLocaleString() ?? '—',
            hpMax: sheet.sheet.vitals?.hpMax?.toLocaleString() ?? '—'
          })}
        </p>
      )}
      <SharePrompt
        asked={asked}
        onCancel={() => setAsked(null)}
        onShare={(control) => {
          setAsked(null);
          set({ ...grant, share: control ? 'control' : 'state' });
        }}
      />
    </div>
  );
}
