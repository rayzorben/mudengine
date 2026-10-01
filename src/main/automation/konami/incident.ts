/**
 * The files of a death log or a stuck log (todos 57, 58): everything needed to
 * tell afterwards whether the provider chose badly or was sent something it
 * should not have been, laid out for another model to read.
 *
 * Pure: the planner hands in what it holds and the session layer writes the
 * files where the character's records live.
 */
import type { CharacterState } from '../../../shared/character';
import type { KonamiPlan } from '../../../shared/konami';
import type { BriefSpot } from '../../../shared/konamiBrief';
import type { KonamiBlow, KonamiDecision, KonamiIncidentKind } from '../../../shared/konamiRecords';

export interface IncidentInput {
  kind: KonamiIncidentKind;
  at: number;
  state: CharacterState;
  realm: string | null;
  lines: string;
  /** Oldest first. */
  decisions: readonly KonamiDecision[];
  plan: KonamiPlan | null;
  blows: readonly KonamiBlow[];
  /** A quiet longer than this between two blows is a new fight (`tuning.konami.fightGapMs`). */
  fightGapMs: number;
  roundSeconds: number;
  /** What each module last said it would not do, newest first. */
  refusals: readonly string[];
}

/** Who landed the blows of the last fight, each named once, where the line named one. */
export function killersOf(blows: readonly KonamiBlow[], gapMs: number): string[] {
  return [
    ...new Set(lastFight(blows, gapMs).flatMap((blow) => (blow.from === null ? [] : [blow.from])))
  ];
}

/** The blows of the last fight: back from the newest to the first quiet gap longer than `gapMs`. */
export function lastFight(blows: readonly KonamiBlow[], gapMs: number): KonamiBlow[] {
  let from = blows.length - 1;
  while (from > 0 && blows[from]!.at - blows[from - 1]!.at <= gapMs) from -= 1;
  return blows.slice(Math.max(0, from));
}

/** The brief's entry for the spot the plan was hunting, as it was sent. */
function huntedSpot(
  decisions: readonly KonamiDecision[],
  plan: KonamiPlan | null
): BriefSpot | null {
  if (plan?.goal.kind !== 'hunt') return null;
  const key = plan.goal.key;
  for (let at = decisions.length - 1; at >= 0; at -= 1) {
    const found = decisions[at]!.brief.hunting.spots.find((spot) => spot.key === key);
    if (found !== undefined) return found;
  }
  return null;
}

export interface DamageReport {
  fight: { blows: number; seconds: number; rounds: number; taken: number; takenPerRound: number };
  hpMax: number | null;
  predicted: {
    spot: string;
    damagePerRoom: number | null;
    worstDamagePerRoom: number | null;
    worstShare: number | null;
    unknown: string[];
  } | null;
  attackers: Array<{
    name: string;
    blows: number;
    damage: number;
    perRound: number;
    predictedPerRound: number | null;
  }>;
  blows: readonly KonamiBlow[];
}

/**
 * What the brief predicted a round beside each monster costs, against what the
 * fight's lines say it took. Rounds are the fight's length over the round,
 * at least one, so a fight of two blows reads as one round and not as none.
 */
export function damageReport(
  fight: readonly KonamiBlow[],
  spot: BriefSpot | null,
  hpMax: number | null,
  roundSeconds: number
): DamageReport {
  const first = fight[0]?.at ?? null;
  const last = fight[fight.length - 1]?.at ?? null;
  const seconds = first === null || last === null ? 0 : (last - first) / 1000;
  const rounds = Math.max(1, Math.ceil(seconds / roundSeconds));
  const byAttacker = new Map<string, { blows: number; damage: number }>();
  let taken = 0;
  for (const blow of fight) {
    taken += blow.damage;
    const who = blow.from ?? '(no attacker named)';
    const known = byAttacker.get(who) ?? { blows: 0, damage: 0 };
    known.blows += 1;
    known.damage += blow.damage;
    byAttacker.set(who, known);
  }
  const predictedFor = (name: string): number | null =>
    spot?.mobs.find((mob) => name.toLowerCase().includes(mob.name.toLowerCase()))?.perRound ?? null;
  return {
    fight: { blows: fight.length, seconds, rounds, taken, takenPerRound: taken / rounds },
    hpMax,
    predicted:
      spot === null
        ? null
        : {
            spot: spot.key,
            damagePerRoom: spot.survival.damagePerRoom,
            worstDamagePerRoom: spot.survival.worstDamagePerRoom,
            worstShare: spot.survival.worstShare,
            unknown: spot.survival.unknown
          },
    attackers: [...byAttacker].map(([name, { blows, damage }]) => ({
      name,
      blows,
      damage,
      perRound: damage / rounds,
      predictedPerRound: predictedFor(name)
    })),
    blows: fight
  };
}

const README: Record<KonamiIncidentKind, string> = {
  death: `A death while the planner was running.

summary.json    what was predicted for the fight against what it took
fight.json      every blow on the character in the last fight, by attacker
plan.json       the plan in force and the brief's entry for the spot hunted
decisions.json  the last decisions, oldest first: brief sent, questions, reply, plan, outcome
character.json  the character as the client read it at the moment of death
session.log     the last lines of the session, colour codes removed

Questions to answer: was the spot offered one it should not have been (the
survival arithmetic in plan.json and the damage in fight.json disagree)? Did
a monster do damage the brief does not count (a spell, a poison, a second
monster)? Or did the provider choose a spot the brief already showed was
dangerous?
`,
  stuck: `The character stood still with a plan in force, a new plan was asked
for, and the provider gave the same plan again.

refusals.json   what each module last said it would not do
plan.json       the plan in force
decisions.json  the last decisions, oldest first
character.json  the character as the client read it
session.log     the last lines of the session, colour codes removed

Questions to answer: why could the plan not be carried out (a route, a shop,
a trainer, a spot the survey no longer offers)? Was the provider offered a
goal the client could not do?
`
};

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export function incidentFiles(input: IncidentInput): Record<string, string> {
  const spot = huntedSpot(input.decisions, input.plan);
  const files: Record<string, string> = {
    'README.txt': README[input.kind],
    'session.log': input.lines,
    'decisions.json': json(input.decisions),
    'character.json': json({ realm: input.realm, at: input.at, state: input.state }),
    'plan.json': json({ plan: input.plan, spot })
  };
  if (input.kind === 'death') {
    const report = damageReport(
      lastFight(input.blows, input.fightGapMs),
      spot,
      input.state.vitals.hpMax,
      input.roundSeconds
    );
    files['fight.json'] = json(report);
    files['summary.json'] = json({
      fight: report.fight,
      hpMax: report.hpMax,
      predicted: report.predicted,
      room: input.state.room.name
    });
  } else {
    files['refusals.json'] = json(input.refusals);
  }
  return files;
}
