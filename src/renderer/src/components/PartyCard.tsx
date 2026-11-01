import { memo } from 'react';

import BentoCard, { type CardChrome } from './BentoCard';
import Icon, { type IconName } from './Icon';
import PartyMemberRow, {
  PARTY_FITS,
  SHEET_FIGURES,
  type PartyBest,
  type Who
} from './PartyMemberRow';
import {
  ratio,
  vitalLevel,
  type CharacterState,
  type MemberSheet,
  type PartyActivity,
  type PartyMember
} from '@shared/character';
import type { VitalsUiConfig } from '@shared/config';
import { t } from '../lib/i18n';
import { isKnownPlayer, isSelf } from '../lib/players';
import { playerKey, recordOf, type PlayerRegistry } from '@shared/players';
import { memberSheetOf } from '@shared/remotes';
import type { PopoverAnchor } from '../lib/popover';
import { tuning } from '../lib/tuning';
import { useFitTier } from '../hooks/useFitTier';

export interface PartyCardProps extends CardChrome {
  character: CharacterState;
  /** The registry, pushed apart from the character: which names are people. */
  players: PlayerRegistry;
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
  players,
  thresholds,
  onSelect,
  subject = null,
  ask,
  ...chrome
}: PartyCardProps) {
  const party = {
    ...character.party,
    members: character.party.members.map((m) => ownRow(character, m))
  };
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

  /*
   * Eight members fit only when each row gives something up, and which drawing
   * fits is measured on the scroller: every row with its stat line, then the
   * stat lines dropped, then one line a member. What a row draws changes only
   * with who is in it and what is known of them, so that is what starts the
   * measuring again; a resize does too.
   */
  const drawn = members
    .map((m) =>
      [
        m.name,
        m.invited,
        m.sheet !== null,
        m.mana !== null,
        m.activity?.state,
        fightingWord(character, m.name),
        hitByWord(character, m.name)
      ].join(':')
    )
    .join(',');
  const [scroller, tier] = useFitTier<HTMLDivElement>(
    PARTY_FITS.length,
    (node) => node.scrollHeight > node.clientHeight,
    drawn
  );
  const fit = PARTY_FITS[tier] ?? 'compact';
  const best = partyBest(members);

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
      paned
      title={t('cards.party.title')}
    >
      <div className="scroller" data-fit={fit} ref={scroller}>
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
                    <PartyMemberRow
                      ask={ask}
                      best={best}
                      fighting={fightingWord(character, member.name)}
                      fit={fit}
                      head={isHead(member)}
                      hitBy={hitByWord(character, member.name)}
                      key={member.name}
                      member={member}
                      onSelect={onSelect}
                      person={isKnownPlayer(players, character, member.name)}
                      selected={playerKey(member.name) === subject}
                      self={isSelf(character, member.name)}
                      thresholds={thresholds}
                      who={whoIs(character, players, member)}
                    />
                  ))}
                </ul>
              </section>
            );
          })
        )}
        {members.length > 0 && <BestHands members={members} />}
      </div>
    </BentoCard>
  );
}

/**
 * This character's own row, from its prompt: the prompt repaints every few
 * hundred milliseconds and the party list is only as fresh as the last `par`.
 * Health and mana need the stat sheet's maxima to be a fraction, so each keeps
 * the party list's figure until one is known; resting is the prompt's once a
 * prompt has been read.
 */
function ownRow(character: CharacterState, member: PartyMember): PartyMember {
  if (!isSelf(character, member.name)) return member;
  const { hp, hpMax, mana, manaMax, resting, meditating } = character.vitals;
  const sheet = memberSheetOf(character.progress);
  const health = ratio(hp, hpMax);
  const magic = ratio(mana, manaMax);
  const activity: PartyActivity | null = resting
    ? { state: 'resting' }
    : meditating
      ? { state: 'meditating' }
      : null;
  return {
    ...member,
    health: health ?? member.health,
    mana: magic ?? member.mana,
    pool: character.vitals.manaType ?? member.pool,
    activity: character.lastStatusAt === null ? member.activity : activity,
    vitals: hp === null || hpMax === null ? member.vitals : { hp, hpMax, mana, manaMax },
    sheet: sheet ?? member.sheet
  };
}

/**
 * Race, class and level: this character's own off its stat sheet, anyone
 * else's off the player record (`bg` states all three) and their `@stats`
 * answer, the newer source for a level. Unknown stays unknown.
 */
function whoIs(character: CharacterState, players: PlayerRegistry, member: PartyMember): Who {
  if (isSelf(character, member.name)) {
    return {
      race: character.race,
      className: character.className ?? member.className,
      level: character.progress.level ?? member.sheet?.level ?? null
    };
  }
  const record = recordOf(players, member.name);
  return {
    race: record?.race ?? null,
    className: member.className ?? record?.className ?? null,
    level: member.sheet?.level ?? record?.level ?? null
  };
}

/** The party's highest of each sheet figure, over the members whose sheet states it. */
function partyBest(members: readonly PartyMember[]): PartyBest {
  const best: Partial<Record<(typeof SHEET_FIGURES)[number], number>> = {};
  for (const member of members) {
    if (member.sheet === null) continue;
    for (const figure of SHEET_FIGURES) {
      const value = member.sheet[figure];
      if (value !== null && value > (best[figure] ?? -Infinity)) best[figure] = value;
    }
  }
  return best;
}

/** The three hands the footer names, each with its glyph and the sheet figure it reads. */
const HANDS: ReadonlyArray<{
  key: string;
  label: string;
  icon: IconName;
  figure(sheet: MemberSheet): number | null;
}> = [
  { key: 'traps', label: t('cards.party.stat.traps'), icon: 'eye', figure: (sheet) => sheet.traps },
  {
    key: 'picks',
    label: t('cards.party.stat.picklocks'),
    icon: 'key',
    figure: (sheet) => sheet.picklocks
  },
  { key: 'bash', label: t('cards.party.bash'), icon: 'hammer', figure: (sheet) => sheet.strength }
];

/**
 * Who the party has for a trap, a lock and a door: the best Traps, Picklocks
 * and Strength among the members whose sheet states one. The question those
 * three figures answer, asked once for the party.
 */
function BestHands({ members }: { members: readonly PartyMember[] }) {
  return (
    <div className="party-best from-medium">
      {HANDS.map(({ key, label, icon, figure }) => {
        let found: { name: string; value: number } | null = null;
        for (const member of members) {
          const value = member.sheet === null ? null : figure(member.sheet);
          if (value !== null && (found === null || value > found.value)) {
            found = { name: member.name, value };
          }
        }
        return (
          <span className="party-hand" data-known={found !== null} key={key} title={label}>
            <Icon name={icon} />
            <em>{label}</em>
            {found === null ? (
              <b>{t('cards.party.sheetUnknown')}</b>
            ) : (
              <>
                <span className="party-hand-name">{found.name}</span>
                <b>{found.value}</b>
              </>
            )}
          </span>
        );
      })}
    </div>
  );
}

/**
 * A member's entry in `engaged` or `threatened`, matched by name as either
 * source spells it, or undefined once the sighting is older than
 * `fightingFreshMs`.
 */
function freshSighting<T extends { at: number }>(
  seen: Readonly<Record<string, T>>,
  name: string
): T | undefined {
  const key = Object.keys(seen).find((entry) => entry.toLowerCase() === name.toLowerCase());
  const entry = key === undefined ? undefined : seen[key];
  return entry && Date.now() - entry.at <= tuning().fightingFreshMs ? entry : undefined;
}

/** What a member was last seen fighting, as the chip says it, or null once the sighting is stale. */
function fightingWord(character: CharacterState, name: string): string | null {
  const seen = freshSighting(character.party.engaged, name);
  if (!seen) return null;
  return seen.kind === 'room'
    ? t('cards.party.fightingRoom')
    : t('cards.party.fighting', { target: seen.target });
}

/** The monster last seen hitting a member, as the chip says it, or null once the sighting is stale. */
function hitByWord(character: CharacterState, name: string): string | null {
  const seen = freshSighting(character.party.threatened, name);
  return seen ? t('cards.party.hitBy', { target: seen.target }) : null;
}

export default memo(PartyCard);
