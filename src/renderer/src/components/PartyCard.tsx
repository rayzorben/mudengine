import { memo } from 'react';

import BentoCard, { type CardChrome } from './BentoCard';
import {
  vitalLevel,
  type CharacterState,
  type PartyActivity,
  type PartyMember
} from '@shared/character';
import type { VitalsUiConfig } from '@shared/config';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import { isKnownPlayer, isSelf, PlayerName } from '../lib/players';
import { playerKey } from '@shared/players';
import type { PopoverAnchor } from '../lib/popover';
import { levelWord, meterValue } from '../lib/vitals';
import { tuning } from '../lib/tuning';

export interface PartyCardProps extends CardChrome {
  character: CharacterState;
  thresholds: VitalsUiConfig;
  /** A member's name clicked: the Player flyout on them, beside the row. */
  onSelect?(name: string, anchor: PopoverAnchor): void;
  /** Whoever the flyout is about, as `playerKey` files them, so the row is marked — tonally, never the name. */
  subject?: string | null;
  /**
   * Proposes a command to the arbiter, the way the Room card asks for a look:
   * `follow <name>` and `leave` are the realm's own party verbs, and a button
   * that sends them goes down the path a keystroke takes. Absent, the card
   * reads and does nothing.
   */
  ask?(command: string): void;
}

/**
 * The formation, as the card lays it out.
 *
 * A rank is what the party is *arranged by* — who takes the blows and who casts
 * from behind them — so the card is arranged by it too, under a heading each,
 * rather than printing the word at the end of every row and leaving the reader
 * to assemble the shape. The realm writes `Frontrank`; a card is not a listing.
 *
 * **A group with nobody in it is not drawn.** An empty heading is a row of
 * vertical space saying nothing, and a party of two is usually two of these
 * five.
 *
 * The last two are not ranks and are deliberately last. `unranked` is somebody
 * an *announcement* added — those carry no rank, and defaulting them to `front`
 * would put a member in the line of fire on the card who is not there on the
 * server. `invited` is an offer nobody has accepted, the one group whose people
 * are not travelling with this character at all.
 */
const GROUPS = [
  { key: 'front', label: t('cards.party.groups.front') },
  { key: 'mid', label: t('cards.party.groups.middle') },
  { key: 'back', label: t('cards.party.groups.back') },
  { key: 'unranked', label: t('cards.party.groups.rankUnknown') },
  { key: 'invited', label: t('cards.party.groups.invited') }
] as const;

type GroupKey = (typeof GROUPS)[number]['key'];

const groupOf = (member: PartyMember): GroupKey =>
  member.invited ? 'invited' : (member.rank ?? 'unranked');

/**
 * What the roster's flag says, in the server's words where it has said them.
 *
 * An unrecognised letter is drawn as the letter, because expanding it would put
 * a condition on the card the server never stated — see `PartyActivity`.
 */
function activityWord(activity: PartyActivity): string {
  return activity.state === 'unknown' ? activity.flag : activity.state;
}

/**
 * A fraction against a track, with the number and the level in words beside it.
 *
 * The party roster gives percentages and no absolutes, so there is no `n/max`
 * to print — the maximum, when this member's client has answered `@health`,
 * goes beside the percentage instead (`meterValue` says why not the pair).
 * The rule from the Vitals card holds unchanged: a null fraction is an empty
 * track, never a full or a zero one, and the level is said in words as well as
 * in hue.
 */
function Bar({
  label,
  fraction,
  max,
  thresholds,
  tone
}: {
  label: string;
  fraction: number | null;
  /** From an `@health` answer, or null when nobody has said. */
  max: number | null;
  thresholds: VitalsUiConfig['hp'];
  tone: string;
}) {
  const level = vitalLevel(fraction, 1, thresholds);
  const word = levelWord(level);
  return (
    <span className={`party-meter ${tone}`} data-level={level}>
      <span className="party-meter-label">{label}</span>
      <span className="party-bar">
        <span style={fraction === null ? undefined : { width: `${fraction * 100}%` }} />
      </span>
      <span className="party-meter-value">
        {meterValue(fraction, max)}
        {word === null ? '' : ` ${word}`}
      </span>
    </span>
  );
}

/**
 * Who is travelling with this character, and how they are doing.
 *
 * The party roster is **the only place another character's health is visible**,
 * and it costs one command rather than a second connection. For a client whose
 * whole point is running several characters, that makes it the most valuable
 * listing on this server — and it went unread until a probe with two accounts
 * went looking for it.
 *
 * Nothing here asks the server for anything. A `party` seeds the roster and the
 * invite, follow, rank and rest announcements maintain it; those carry no
 * health, so a member added that way has none until the next listing and the
 * card **says so** rather than drawing an empty bar as though it meant zero.
 *
 * An **invitation is on the card from the moment it goes out**, under a heading
 * of its own. That is the moment the player is watching for an answer, and the
 * card was the one thing on screen with nothing to say about it: the listing
 * printed while an offer was outstanding read as a party of one, so the card
 * disappeared instead.
 */
function PartyCard({
  character,
  thresholds,
  onSelect,
  subject = null,
  ask,
  ...chrome
}: PartyCardProps) {
  const { party } = character;
  const hurt = party.members.filter(
    (member) => vitalLevel(member.health, 1, thresholds.hp) === 'critical'
  ).length;

  /*
   * The badge reports the number somebody acts on. "One hurt" is a reason to
   * heal; "three in the party" is trivia they can already see — and while an
   * invitation is the only thing on the roster, the number travelling together
   * is nobody, so the badge states the offer instead of counting it as company.
   */
  const invited = party.members.filter((entry) => entry.invited).length;
  const together = party.members.length - invited;
  const badge =
    hurt > 0 ? (
      <span className="chip bad">{t('cards.party.badge.hurt', { count: hurt })}</span>
    ) : together > 0 ? (
      <span className="chip off">{t('cards.party.badge.together', { count: together })}</span>
    ) : (
      <span className="chip off">{t('cards.party.badge.invited', { count: invited })}</span>
    );

  /*
   * The head of the party goes first, whatever order the listing arrived in.
   *
   * That is whoever this character follows, and this character itself when it
   * follows nobody — `You are following <name>.` is printed only for a member
   * that is not at the head of what it can see. `sort` is stable, so everybody
   * else keeps the order the server chose, and the copy keeps the state's own
   * array untouched.
   *
   * Compared case-insensitively, because the two sources spell a name
   * differently: the roster formats a column and the login echoes what the
   * player typed, so `Welcome back, soul!` leaves `character.name` lower case
   * against the listing's `Soul`.
   */
  const head = (party.following ?? character.name)?.toLowerCase() ?? null;
  const isHead = (member: PartyMember): boolean => member.name.toLowerCase() === head;
  const members =
    head === null
      ? party.members
      : [...party.members].sort((a, b) => Number(isHead(b)) - Number(isHead(a)));

  return (
    <BentoCard
      {...chrome}
      actions={
        ask && members.length > 0
          ? [
              {
                id: 'leave',
                label: t('cards.party.leaveAction'),
                icon: 'popout',
                run: () => ask('leave'),
                danger: true
              }
            ]
          : []
      }
      badge={badge}
      className="party-card"
      title={t('cards.party.title')}
    >
      {members.length === 0 ? (
        <div className="empty">{t('cards.party.empty')}</div>
      ) : (
        GROUPS.map(({ key, label }) => {
          const inRank = members.filter((entry) => groupOf(entry) === key);
          if (inRank.length === 0) return null;
          return (
            <section className="party-rank-group" data-rank={key} key={key}>
              <h4 className="party-rank-head">{label}</h4>
              <ul className="party-list">
                {inRank.map((member) => (
                  <li
                    data-selected={playerKey(member.name) === subject ? 'true' : undefined}
                    key={member.name}
                  >
                    <div className="party-who">
                      {/* A member the registry or roster knows is a person, and a
                          person's name is the control that opens their card — the
                          same gesture as on the Realm and Players listings, gated
                          by the same test rather than by "a member is a person".
                          This character's own row stays text: its numbers are on
                          the Vitals card. */}
                      <span className="party-name" data-leader={isHead(member)}>
                        {onSelect && isKnownPlayer(character, member.name) ? (
                          <PlayerName
                            className="name"
                            name={member.name}
                            onSelect={onSelect}
                            self={isSelf(character, member.name)}
                          />
                        ) : (
                          member.name
                        )}
                      </span>
                      <span className="party-class">{member.className ?? ''}</span>
                      {/*
                        A condition is tonal, per §9 — and it is the thing on
                        this row that decides whether a member will answer a
                        heal or a step.
                      */}
                      {member.activity !== null && (
                        <span className="party-activity" data-state={member.activity.state}>
                          {activityWord(member.activity)}
                        </span>
                      )}
                      {/* What the server last said this member hit, while the
                          sighting is fresh: the fact `assistLeader` acts on,
                          shown where the person deciding to help can see it. */}
                      {fightingWord(character, member.name) !== null && (
                        <span className="chip quiet party-fighting">
                          {t('cards.party.fighting', {
                            target: fightingWord(character, member.name) ?? ''
                          })}
                        </span>
                      )}
                      {/* `follow <name>` is how a leader is made on this realm;
                          there is no verb for the other direction, so there is
                          no other button. Not for this character's own row, and
                          not for whoever is already followed. */}
                      {ask &&
                        !member.invited &&
                        !isSelf(character, member.name) &&
                        !isHead(member) && (
                          <button
                            aria-label={t('cards.party.followAria', { name: member.name })}
                            className="quiet party-follow"
                            onClick={() => ask(`follow ${member.name}`)}
                            onMouseDown={keepFocus}
                            type="button"
                          >
                            {t('cards.party.followButton')}
                          </button>
                        )}
                    </div>
                    {/*
                      A member the announcements added has no numbers at all
                      until the next listing, and two empty tracks would read as
                      two resources at zero. An *invited* member has none either
                      and for a different reason — they have not answered — which
                      the heading above them already says, so the row says
                      nothing a second time.
                    */}
                    {member.invited ? null : member.health === null ? (
                      <span className="hint">{t('cards.party.notYetListed')}</span>
                    ) : (
                      <div className="party-meters">
                        <Bar
                          fraction={member.health}
                          label={t('cards.party.bar.hp')}
                          max={member.vitals?.hpMax ?? null}
                          thresholds={thresholds.hp}
                          tone="hp"
                        />
                        {/* No mana track for a class that has none — the roster
                            omits the column entirely, and an empty one would
                            imply a resource that does not exist. */}
                        {member.mana !== null && (
                          <Bar
                            fraction={member.mana}
                            label={t('cards.party.bar.mana')}
                            max={member.vitals?.manaMax ?? null}
                            thresholds={thresholds.mana}
                            tone="mana"
                          />
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          );
        })
      )}
    </BentoCard>
  );
}

/** The monster a member was last seen fighting, or null once the sighting is stale. */
function fightingWord(character: CharacterState, name: string): string | null {
  const key = Object.keys(character.party.engaged).find(
    (entry) => entry.toLowerCase() === name.toLowerCase()
  );
  const seen = key === undefined ? undefined : character.party.engaged[key];
  if (!seen || Date.now() - seen.at > tuning().fightingFreshMs) return null;
  return seen.target;
}

export default memo(PartyCard);
