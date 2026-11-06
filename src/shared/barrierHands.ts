/**
 * Who in the party goes at a trapped way or a locked door, and at what odds
 * (todo 86). One statement of each roll, from the GreaterMUD source:
 * `TrapExit.TryDisarm` (`disarmOdds`), `Door.TryPickLock` and
 * `Door.TryBashDoor`. The leader ranks itself and every joined member by it;
 * a member's client reads the same odds to bound its own tries.
 * `mudengine-automation` › parts/remotes.md.
 */
import { healthFraction } from './automation';
import { joinedMembers, standingHere, type CharacterState } from './character';
import { barrierStated, disarmOdds } from './walk';
import type { Requirement } from './world';

/** What a member is asked to do at the way: `@disarm`, `@pick`, `@bash`. */
export const BARRIER_JOBS = ['disarm', 'pick', 'bash'] as const;
export type BarrierJob = (typeof BARRIER_JOBS)[number];
/** The jobs at a trapped way, and at a locked door: each caller waits only on its own. */
export const TRAP_JOBS: readonly BarrierJob[] = ['disarm'];
export const DOOR_JOBS: readonly BarrierJob[] = ['pick', 'bash'];

/**
 * A member's answer to being sent: `held` (their `{ok}` to `@disarm`,
 * `@pick` or `@bash`), `failed`, or `tried`, an `@do` the member's client
 * took, which answers `{ok}` on taking it, before the roll: the room says
 * whether the lock gave.
 */
export type HandAnswer = 'held' | 'failed' | 'tried';

/**
 * A member sent at the way, until their answer (todo 133). `withdraw` ends
 * this ask once the walk no longer waits on it, so a later `{ok}` or
 * `{failed}` is not read as the job; it leaves a newer ask to them alone.
 */
export interface HandAsk {
  withdraw(): void;
}

/** The command each job sends at the way, as `DisarmCommand.cs` and `PickCommand.cs` read it. */
export function jobCommand(job: BarrierJob, direction: string): string {
  switch (job) {
    case 'disarm':
      return `disarm trap ${direction}`;
    case 'pick':
      return `pi ${direction}`;
    case 'bash':
      return `bas ${direction}`;
    default: {
      const never: never = job;
      return never;
    }
  }
}

/** The figures a job is rolled on, null where the sheet has not said. */
export interface HandSheet {
  strength: number | null;
  traps: number | null;
  picklocks: number | null;
}

/** One who could go: this character or a joined member. */
export interface Candidate {
  name: string;
  self: boolean;
  sheet: HandSheet;
  /** Hit points now, or null when nothing has said the absolute figure. */
  hp: number | null;
  /** Health as a share of the maximum, 0–1, or null when nothing has said. */
  share: number | null;
}

/** A candidate with the odds one try holds. */
export interface Hand {
  name: string;
  self: boolean;
  odds: number;
}

/**
 * The chance `skill − need ≥ rand(0,100)`, the roll both door commands make
 * (the realm's figure is the server's modifier negated). 101 outcomes.
 */
function doorRoll(skill: number, need: number): number {
  return Math.min(1, Math.max(0, (skill - need + 1) / 101));
}

/**
 * The figure the realm states for one channel of a barrier, or null when that
 * channel is shut: `meetsBarrier`'s reading. No figure at all is a plain
 * door (0), or a key-only one; a figure for the other channel only shuts this one.
 */
function needOf(need: Requirement | null | undefined, channel: number | undefined): number | null {
  // A lock with a key and no figure: only that key opens it (`RoomManager`, -999).
  if (!barrierStated(need)) return need?.keyId === undefined ? 0 : null;
  if (channel === undefined) return null;
  return Math.max(0, channel);
}

/** The chance one try at `job` holds for this sheet, or null when unknown. */
export function jobOdds(
  job: BarrierJob,
  sheet: HandSheet,
  need: Requirement | null | undefined
): number | null {
  switch (job) {
    case 'disarm':
      return disarmOdds(sheet.traps);
    case 'pick': {
      if (sheet.picklocks === null) return null;
      // `Door.TryPickLock` needs `Picklocks + modifier > 0` before it rolls.
      const figure = needOf(need, need?.pickDifficulty);
      return figure === null || sheet.picklocks - figure <= 0
        ? 0
        : doorRoll(sheet.picklocks, figure);
    }
    case 'bash': {
      if (sheet.strength === null) return null;
      const figure = needOf(need, need?.bashDifficulty);
      return figure === null ? 0 : doorRoll(sheet.strength, figure);
    }
    default: {
      const never: never = job;
      return never;
    }
  }
}

/** This character and every joined member, with what is known of each. */
export function candidatesOf(state: CharacterState): Candidate[] {
  const { strength, traps, picklocks } = state.progress;
  const self: Candidate = {
    name: state.name ?? '',
    self: true,
    sheet: { strength, traps, picklocks },
    hp: state.vitals.hp,
    share: healthFraction(state)
  };
  const members = joinedMembers(state).map((member): Candidate => ({
    name: member.name,
    self: false,
    sheet: {
      strength: member.sheet?.strength ?? null,
      traps: member.sheet?.traps ?? null,
      picklocks: member.sheet?.picklocks ?? null
    },
    hp: member.vitals?.hp ?? null,
    share: member.health
  }));
  return [self, ...members];
}

/** The candidates a leader can send at the way: this character and the members standing here. */
export function candidatesHere(state: CharacterState): Candidate[] {
  const here = standingHere(state);
  return candidatesOf(state).filter(
    (candidate) => candidate.self || here.has(candidate.name.toLowerCase())
  );
}

/**
 * How many walk a trapped way: leading, this character and the joined members
 * behind it; following, the leader's walk decides, so one.
 */
export function walkersThrough(state: CharacterState): number {
  return state.party.following === null ? 1 + joinedMembers(state).length : 1;
}

/**
 * The best figure on one channel: following, this character's own; leading,
 * the best stated among it and its joined members. Traps prices a trap the
 * walk sends the best hand at; Picklocks and Strength a lock. This
 * character's own counts only where its switch lets it try (`selfTries`):
 * *Auto-Pick Locks* and *Auto-Bash Doors* are this character's own tries, and
 * a member is sent either way (the user, 2026-11-05). Null when nobody's is
 * known.
 */
export function partyFigure(
  state: CharacterState,
  channel: keyof HandSheet,
  selfTries = true
): number | null {
  const leading = state.party.following === null;
  const figures = candidatesOf(state)
    .filter((candidate) => (candidate.self ? selfTries : leading))
    .map((candidate) => candidate.sheet[channel])
    .filter((figure): figure is number => figure !== null);
  return figures.length === 0 ? null : Math.max(...figures);
}

/**
 * Members with no figure for `job`, who can still be sent `@do pi` or `@do
 * bas` after every member with known odds. A failed pick costs nothing
 * (`Door.TryPickLock`) and a failed bash a few hit points; a lock that held
 * stops the move, so the walk opens it to see (the user, 2026-11-05, asked
 * for the bash). A bash only for a member whose health share the listing
 * gives at `restBelow` or over, the leader's own bash's floor
 * (`tooHurtToBash`); unknown is the unsafe case. Never a disarm, which fires
 * the trap on unknown odds, nor a channel the lock shuts (`needOf`).
 */
export function unknownHands(
  job: BarrierJob,
  need: Requirement | null | undefined,
  candidates: readonly Candidate[],
  restBelow: number
): string[] {
  switch (job) {
    case 'disarm':
      return [];
    case 'pick':
    case 'bash': {
      const channel = job === 'pick' ? need?.pickDifficulty : need?.bashDifficulty;
      if (needOf(need, channel) === null) return [];
      const figure = job === 'pick' ? 'picklocks' : 'strength';
      const fit = (share: number | null): boolean =>
        job === 'pick' || (share !== null && share >= restBelow);
      return candidates
        .filter(
          (candidate) => !candidate.self && candidate.sheet[figure] === null && fit(candidate.share)
        )
        .map((candidate) => candidate.name);
    }
    default: {
      const never: never = job;
      return never;
    }
  }
}

/**
 * Who goes, best odds first, this character ahead of a member at the same
 * odds since its own try costs no telepath. Left out: anyone whose odds are
 * unknown or nil, and for a disarm anyone a known trap would kill or whose
 * hit points are unknown, since a failed disarm fires the trap at them for its
 * full damage (`TrapExit.TryDisarm`).
 */
export function handsFor(
  job: BarrierJob,
  need: Requirement | null | undefined,
  damage: number | null,
  candidates: readonly Candidate[]
): Hand[] {
  const hands: Hand[] = [];
  for (const candidate of candidates) {
    const odds = jobOdds(job, candidate.sheet, need);
    if (odds === null || odds <= 0) continue;
    if (job === 'disarm' && damage !== null && (candidate.hp === null || candidate.hp <= damage)) {
      continue;
    }
    hands.push({ name: candidate.name, self: candidate.self, odds });
  }
  return hands.sort((a, b) => b.odds - a.odds || Number(b.self) - Number(a.self));
}
