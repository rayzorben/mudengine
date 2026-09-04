/**
 * The rule format.
 *
 * A rule is *configuration*, not code — but it is written against this
 * project's own vocabulary, not ported from anywhere. `tproxy`'s YAML was a
 * Telnet proxy's configuration: template matchers over a relayed byte stream,
 * because it had no parser and no state model to work from. We have both, so a
 * rule matches on typed facts the classifier already produced and emits an
 * intent the arbiter already knows how to pace. See
 * docs/legacy-assessment.md §3 and consequence 5.
 *
 * The shape is deliberately small:
 *
 *     when   — the trigger: a block type, or every state change
 *     if     — guards over CharacterState, all of which must hold
 *     then   — intents to propose
 *
 * Everything a rule can say is checkable against the type system, so a typo in
 * a rule file is a load error rather than a rule that silently never fires —
 * which is the failure mode of a stringly-typed DSL.
 */
import type { Priority } from './automation';

/** Fields a guard can test. Closed on purpose: a typo must not be a no-op. */
export type GuardField =
  /** 0–1, or absent when the maximum is unknown. */
  | 'hp.percent'
  | 'hp'
  | 'mana.percent'
  | 'mana'
  | 'level'
  | 'inCombat'
  | 'resting'
  | 'meditating'
  /** Count of entries on the `Also here:` line. */
  | 'occupants'
  /**
   * Of those, the ones that are monsters rather than people.
   *
   * Settled by the realm roster, by the annotations the room listing hangs off
   * a player's name, and by the realm's own monster table — and only where all
   * three say nothing does the capitalisation heuristic `tproxy` contributed
   * decide it. See `RoomOccupant`.
   */
  | 'mobs'
  /**
   * Of those, the ones that will attack this character on sight.
   *
   * The number worth acting on: `mobs` counts a shopkeeper and a guard dog
   * alike, and only one of them is a reason to keep moving. Read out of
   * `Monsters.Align` and `Monsters.Type` per `shared/mobs.ts`, and counted
   * against this character's *own* standing, because two of the seven monster
   * alignments decide by it.
   *
   * Under-reports rather than crying wolf: a monster the realm data cannot
   * place, and a conditional one met before a `who` has said how the realm
   * ranks this character, are both unknown — and unknown is not counted.
   */
  | 'threats'
  /**
   * Occupants **known** to be players, by name, from the realm roster.
   *
   * Known rather than guessed: `mobs` is a spelling heuristic and this is a
   * cross-reference against who a `who` listing said is here. It under-reports
   * — somebody who arrived before the last listing and has not been announced
   * is not counted — which is the right direction for a guard that decides
   * whether to run.
   */
  | 'players'
  /** Of those, the ones the realm calls Outlaw, Criminal, Villain or FIEND. */
  | 'hostiles'
  /**
   * Whether the client can see any reason a disconnect would be penalised.
   *
   * False is meaningful; true is only "no reason found". Four of the five
   * conditions are visible to a client and the room flags are not. See
   * `HangUp.ts` and docs/greatermud/combat.md.
   */
  | 'hangUpClean'
  /**
   * What this character is fighting, by name — so a rule can say
   * `attack {target}` rather than guessing.
   *
   * Unknown until it swings at something: being attacked says what is fighting
   * *you*, which is a different question and is `attackers`.
   */
  | 'target'
  /** How many things are hitting this character. The number that decides a retreat. */
  | 'attackers'
  /**
   * How many are travelling with this character, including it. Zero when alone.
   *
   * Exists so a rule can *keep the roster fresh*: the party listing is the only
   * place another member's health is visible, and it is only as current as the
   * last `party`. One command every twenty seconds while there is a party to
   * watch, and none at all when there is not.
   */
  | 'partySize'
  /**
   * `sneaking`, `seen`, or unknown until the server has said either.
   *
   * Unknown is not `seen`: a rule that guards on being unseen must not fire
   * because nothing has happened yet, and one that guards on being *seen* must
   * not fire before anybody has looked.
   */
  | 'stealth'
  | 'wealth'
  | 'phase'
  /**
   * Which member of the family the wire said this is — `majormud`,
   * `greatermud` or `paradigm`. Unknown until the banner or the status line
   * has said, so a rule guarding on it cannot fire before the client knows.
   *
   * Read since the realm was first detected and **absent from `GUARD_FIELDS`
   * for the whole of that time**, which is precisely the closed-union failure
   * the list's own comment warns about: the type accepted it, the reader
   * answered it, and the parser refused it — so any rule written against the
   * documented field silently never loaded.
   */
  | 'realm'
  /**
   * What the realm says about the room the character is standing in — five
   * facts that became askable when the room started carrying entities
   * (2026-09-02).
   *
   * Every one of them was already in the client's memory and unreachable from
   * a rule: the shop and the lair were IPC calls a card made, and the three
   * monster facts were fields on a `WorldMob` nothing joined to the occupant
   * list. A guard could count how many things were in the room and could not
   * ask whether any of them was undead.
   *
   * Named flat, like `mobs` and `hostiles` beside them, rather than
   * `room.mobs.hasHostile` — a dotted name here would be the only one in the
   * union, and the counts it would introduce (`room.mobs.count`) already exist
   * under `mobs` and `players`. A synonym is a bug in the vocabulary.
   */
  /** Whether the realm records a shop in this room. */
  | 'shopHere'
  /** Whether the realm marks this room a lair. */
  | 'lairHere'
  /** How many monsters here the realm marks undead. */
  | 'undeadHere'
  /**
   * The most health any monster here is known to have, or **unknown** when the
   * realm can place none of them — never 0, which would read as an empty room
   * and is the reassuring answer.
   */
  | 'toughestHere'
  /**
   * How many monsters here the realm says cast a spell when they die.
   *
   * Nothing in the stream says so until it already has, which is what makes it
   * worth a guard: 146 of the shipped realm's monsters carry one.
   */
  | 'deathSpellHere'
  /**
   * Whether the character cannot see where it is standing — the server's own
   * light phrase, or the realm recording this room as dark.
   *
   * The **server's word leads**: `dimly lit`, `barely visible`, `very dark` and
   * `pitch black` are what it actually printed, and the realm's own light level
   * answers only when it printed none. Unknown until one of the two says
   * something, so a guard cannot fire in a lit room the client has merely not
   * been told about.
   */
  | 'dark'
  /**
   * What this character has to see by: `carried`, `spent` or `none`.
   *
   * The pack's own answer, from `ItemEntity.kind === 'light'` and the charges a
   * listing counted. **A spent light beats a full one only when nothing usable
   * was found** — a character carrying a dead pearl and a live torch is fine —
   * and charges *unstated* is not zero, because the listing simply did not
   * count and a guard fired on an unknown would cry wolf on every torch.
   *
   * This is the pair `dark` exists for. `Walker` warns before stepping into a
   * dark room and deliberately does not act, on the grounds that lighting a
   * torch is a command spent on a guess about what the player wants — and it
   * points at `automation.rules` as where automatic lighting belongs. It could
   * not be written there until these two fields existed, which made that a
   * decision with nowhere to go.
   */
  | 'light';

export type Comparison = '<' | '<=' | '>' | '>=' | '==' | '!=';

export interface Guard {
  field: GuardField;
  op: Comparison;
  /** Compared numerically when both sides are numbers, else as strings. */
  value: number | string | boolean;
}

/** What fires a rule. */
export type Trigger =
  /** A classified line of the named block type. */
  | { kind: 'block'; type: string }
  /** Any change to character state. */
  | { kind: 'state' }
  /**
   * ~100 ms after the last combat message: *inside* a round rather than
   * between rounds. Not obvious, and load-bearing for competitive play — the
   * one piece of timing knowledge worth taking from `tproxy`.
   */
  | { kind: 'mid-round' }
  /** Every `everyMs`, while in the realm. */
  | { kind: 'timer'; everyMs: number };

export interface RuleAction {
  /**
   * The command to send. `{name}` interpolates a capture group from the
   * triggering block, or a state field.
   */
  command: string;
  priority: Priority;
  /** Collapses duplicates of the same intent while queued. */
  coalesce?: string;
  /** Dropped if it has not been sent within this long. */
  expiresMs?: number;
}

export interface Rule {
  name: string;
  enabled: boolean;
  when: Trigger;
  if: Guard[];
  then: RuleAction[];
  /** Minimum gap between firings, so a rule cannot chatter. */
  cooldownMs: number;
}

/** What a rule did, for the decision trace. */
export interface RuleFiring {
  at: number;
  rule: string;
  commands: string[];
  /** Which guard rejected it, when it did not fire. */
  blockedBy?: string;
}
