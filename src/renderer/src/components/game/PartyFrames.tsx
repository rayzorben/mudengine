/**
 * The game view's party frames (todo 140), down the left: the character, then
 * each member with an HP bar and a mana or kai bar. A member not in the room
 * is dimmed; a share nobody has reported is a hatched bar, never empty.
 */
import { memo } from 'react';

import type { CharacterState } from '@shared/character';
import { t } from '../../lib/i18n';

const share = (value: number | null, max: number | null): number | null =>
  value === null || max === null || max <= 0 ? null : Math.max(0, Math.min(1, value / max));

function Bar({ value, tone }: { value: number | null; tone: 'hp' | 'mana' | 'kai' }) {
  return (
    <div className="gv-thin" data-tone={tone} data-unknown={value === null ? 'true' : undefined}>
      <i style={{ width: `${(value ?? 0) * 100}%` }} />
    </div>
  );
}

function PartyFrames({ character }: { character: CharacterState }) {
  const { vitals, party, room } = character;
  const here = new Set(room.occupants.map((one) => one.name.toLowerCase()));
  const self = character.name?.toLowerCase() ?? null;
  const members = party.members.filter((member) => member.name.toLowerCase() !== self);
  if (members.length === 0) return null;
  const level = character.progress.level;
  return (
    <aside className="gv-hud gv-glass gv-party">
      <div className="gv-frame" data-self="true">
        <i className="gv-frame-mark" />
        <div>
          <div className="gv-frame-row">
            <b>
              {character.name ?? t('game.arena.you')}
              <small>{[character.className, level].filter((one) => one !== null).join(' ')}</small>
            </b>
            <span>{vitals.hp ?? '?'}</span>
          </div>
          <Bar tone="hp" value={share(vitals.hp, vitals.hpMax)} />
          {vitals.manaType !== null && (
            <Bar
              tone={vitals.manaType === 'KAI' ? 'kai' : 'mana'}
              value={share(vitals.mana, vitals.manaMax)}
            />
          )}
          <div className="gv-frame-note">
            {character.afflictions.poisoned === 'yes' ? (
              <span data-tone="poison">{t('game.status.poisoned')}</span>
            ) : null}
          </div>
        </div>
      </div>
      {members.map((member) => {
        const away = !here.has(member.name.toLowerCase());
        const activity =
          member.activity?.state === 'resting'
            ? t('game.status.resting')
            : member.activity?.state === 'meditating'
              ? t('game.status.meditating')
              : null;
        return (
          <div className="gv-frame" data-away={away ? 'true' : undefined} key={member.name}>
            <i className="gv-frame-mark" />
            <div>
              <div className="gv-frame-row">
                <b>
                  {member.name}
                  <small>
                    {[member.className, member.sheet?.level ?? null]
                      .filter((one) => one !== null)
                      .join(' ')}
                  </small>
                </b>
                <span>{member.health === null ? '?' : `${Math.round(member.health * 100)}%`}</span>
              </div>
              <Bar tone="hp" value={member.health} />
              {member.mana !== null && <Bar tone="mana" value={member.mana} />}
              <div className="gv-frame-note">
                {away ? (
                  <span>{t('game.party.away')}</span>
                ) : activity === null ? null : (
                  <span>{activity}</span>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </aside>
  );
}

export default memo(PartyFrames);
