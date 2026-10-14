/**
 * Which settings govern each decision the client makes on its own (todo 118).
 *
 * One home for the fact, so a line the client writes about a decision and the
 * setting behind it cannot drift apart: the terminal's gear icon (todo 119)
 * opens these paths. Every decision is also under the master switch,
 * `automation.enabled`, which no entry repeats. See `mudengine-automation`.
 */
import type { AppConfig, Server } from './config';
import type { Loop, LoopStop } from './loops';
import type { Profile } from './profiles';

/** A value a path stops at: a scalar or a list. */
type Stop = string | number | boolean | null | readonly unknown[];

/**
 * Every dotted path into `T`, four levels deep at most. A map keyed by the
 * player's own words (`aliases`) is a stop too: its keys are not settings.
 */
type PathsOf<T, Depth extends readonly unknown[] = []> = Depth['length'] extends 4
  ? never
  : {
      [K in keyof T & string]: T[K] extends Stop
        ? K
        : string extends keyof T[K]
          ? K
          : T[K] extends object
            ? K | `${K}.${PathsOf<T[K], [...Depth, unknown]>}`
            : K;
    }[keyof T & string];

/** A setting a decision reads: in the options or character file, a realm's file, a loop's file. */
export type SettingPath =
  | `automation.${PathsOf<AppConfig['automation']>}`
  | `connection.login.${PathsOf<AppConfig['connection']['login']>}`
  | `profile.${keyof Pick<Profile, 'lowLives' | 'autoReconnect' | 'locate'>}`
  | `server.${keyof Pick<Server, 'login' | 'hangPenalties' | 'fleeGoto'>}`
  | `loop.${keyof Pick<Loop, 'stops' | 'bounce'> | keyof Pick<LoopStop, 'linger' | 'every'>}`;

/**
 * The settings behind a decision, or the date it was found to have none of its
 * own. An `awaiting` row becomes a list when its setting is added.
 */
export type DecisionSettings =
  readonly [SettingPath, ...SettingPath[]] | { readonly awaiting: string };

export const DECISION_SETTINGS = {
  // Combat
  'attack-master-switch': [
    'automation.combat.enabled',
    'automation.combat.retaliate',
    'automation.combat.engage'
  ],
  'mortally-wounded-stop': { awaiting: '2026-10-11' },
  'hit-back': [
    'automation.combat.retaliate',
    'automation.combat.mobRules',
    'automation.combat.maxMonsterExperience',
    'automation.combat.maxTargetHealth'
  ],
  'hit-back-pick': ['automation.combat.mobRules'],
  'broken-fight-owed': { awaiting: '2026-10-11' },
  'assist-leader': ['automation.party.assistLeader'],
  'defend-party': ['automation.party.defendParty'],
  'engage-gate': [
    'automation.combat.engage',
    'automation.combat.maxMobs',
    'automation.combat.minMobs',
    'automation.combat.mobRules'
  ],
  'typed-break': { awaiting: '2026-10-11' },
  'row-stance': ['automation.combat.mobRules'],
  'polite-claim': ['automation.combat.politeAttacks', 'automation.combat.mobRules'],
  'costly-refuse': { awaiting: '2026-10-11' },
  'cannot-hurt': { awaiting: '2026-10-11' },
  'weapon-swap': { awaiting: '2026-10-11' },
  'realm-avoid': ['automation.combat.mobRules'],
  'fled-from': { awaiting: '2026-10-11' },
  'exp-cap': ['automation.combat.maxMonsterExperience'],
  'hp-cap': ['automation.combat.maxTargetHealth'],
  'row-not-hostile': ['automation.combat.mobRules', 'automation.combat.engage'],
  'uncertain-hostility': ['automation.combat.engage'],
  'not-hostile': ['automation.combat.engage'],
  'planned-fight': { awaiting: '2026-10-11' },
  'guarded-refuse': ['automation.combat.mobRules'],
  'attack-target': ['automation.combat.mobRules'],
  'engage-cooldown': { awaiting: '2026-10-11' },
  opener: ['automation.combat.opener', 'automation.combat.mobRules'],
  'opener-chosen': ['automation.combat.opener'],
  'attack-verb': ['automation.combat.attack'],
  'spell-opener': ['automation.spells.attack', 'automation.spells.autoChoose'],
  'attack-spell': [
    'automation.spells.attack',
    'automation.spells.attackFallback',
    'automation.spells.autoChoose',
    'automation.spells.attackCasts',
    'automation.spells.minMana',
    'automation.combat.mobRules'
  ],
  'auto-choose-spell': ['automation.spells.autoChoose', 'automation.spells.attackCasts'],
  'spell-held-melee': ['automation.spells.minMana', 'automation.combat.mobRules'],
  'drain-standin': [
    'automation.spells.drain',
    'automation.spells.areaDrain',
    'automation.spells.drainBelow',
    'automation.spells.drainTo',
    'automation.spells.autoChoose'
  ],
  'room-spell': [
    'automation.spells.areaAttack',
    'automation.spells.areaMinMobs',
    'automation.spells.areaMinMana',
    'automation.spells.minMana',
    'automation.spells.areaCasts',
    'automation.spells.autoChoose'
  ],
  'room-debuff-first': ['automation.spells.autoChoose', 'automation.combat.mobRules'],
  'round-change': ['automation.spells.attack', 'automation.combat.attack'],
  'break-area': { awaiting: '2026-10-11' },
  'cast-round-gate': { awaiting: '2026-10-11' },
  'room-refresh': ['automation.combat.refreshRounds'],
  'arrival-reread': { awaiting: '2026-10-11' },
  'hide-sneak': [
    'automation.combat.hideForOpener',
    'automation.combat.opener',
    'automation.combat.enabled'
  ],
  search: ['automation.search.enabled', 'automation.search.tries'],
  'unlisted-searcher': { awaiting: '2026-10-11' },
  'backstab-hands': { awaiting: '2026-10-11' },
  // Recovery
  'rest-health': [
    'automation.health.restBelow',
    'automation.health.restTo',
    'automation.combat.mobRules'
  ],
  'med-mana': [
    'automation.health.restBelowMana',
    'automation.health.restToMana',
    'automation.health.useMeditate',
    'automation.health.meditateFirst'
  ],
  'rest-for-mana': [
    'automation.health.restBelowMana',
    'automation.health.restToMana',
    'automation.health.useMeditate'
  ],
  'rest-med-switch': [
    'automation.health.meditateFirst',
    'automation.health.useMeditate',
    'automation.health.restBelow',
    'automation.health.restBelowMana'
  ],
  'rest-for-members': ['automation.party.manageParty', 'automation.health.restTo'],
  'rest-with-leader': ['automation.party.restWithLeader', 'automation.health.useMeditate'],
  'rest-away': ['automation.health.restNextDoor'],
  'rest-away-back': ['automation.health.restNextDoor'],
  'rest-spell': ['automation.health.restSpell'],
  'heal-self': [
    'automation.spells.heal',
    'automation.spells.healBelow',
    'automation.spells.healBelowInCombat',
    'automation.spells.healTo',
    'automation.spells.autoChooseHeal',
    'automation.spells.healMinMana'
  ],
  'heal-party': [
    'automation.spells.healParty',
    'automation.spells.healPartyWith',
    'automation.spells.healBelow',
    'automation.spells.healBelowInCombat',
    'automation.spells.autoChooseHeal',
    'automation.spells.healMinMana'
  ],
  'heal-request': [
    'automation.spells.healBelow',
    'automation.spells.healParty',
    'automation.spells.healPartyWith',
    'automation.spells.autoChooseHeal'
  ],
  'cure-self': [
    'automation.spells.cures',
    'automation.spells.autoChoose',
    'automation.spells.minMana'
  ],
  'cure-party': [
    'automation.spells.healParty',
    'automation.spells.cures',
    'automation.spells.minMana'
  ],
  potion: ['automation.health.potions'],
  bless: [
    'automation.spells.autoBless',
    'automation.spells.blessings',
    'automation.spells.autoChooseBlessings'
  ],
  'bless-expired-notify': ['automation.spells.notifyPartyOnWearOff'],
  'bless-choose': ['automation.spells.autoChooseBlessings', 'automation.spells.blessings'],
  'invoke-item': ['automation.spells.invokeItems', 'automation.spells.invokeWith'],
  'mana-floor': ['automation.spells.minMana', 'automation.spells.healMinMana'],
  rules: ['automation.rules'],
  event: ['automation.events'],
  // Safety
  'hang-up': [
    'automation.safety.hangUp.enabled',
    'automation.safety.hangUp.belowHealth',
    'automation.safety.hangUp.onPlayerInRoom',
    'automation.safety.hangUp.penalties',
    'automation.combat.mobRules',
    'server.hangPenalties'
  ],
  'hang-up-naked': { awaiting: '2026-10-11' },
  'hang-up-pvp': ['automation.safety.pvp.action'],
  'pvp-run': ['automation.safety.pvp.action', 'automation.safety.retreat.cooldownMs'],
  'pvp-gang': ['automation.safety.pvp.notifyGang'],
  'run-away': [
    'automation.safety.retreat.enabled',
    'automation.safety.retreat.belowHealth',
    'automation.safety.retreat.belowMana',
    'automation.safety.retreat.whenOutnumbered',
    'automation.safety.retreat.cooldownMs',
    'automation.combat.mobRules'
  ],
  'run-direction': { awaiting: '2026-10-11' },
  'run-open-door': ['automation.movement.openDoors', 'automation.movement.openTries'],
  'run-to-room': ['automation.safety.retreat.strategy', 'automation.safety.retreat.safeHavenRoom'],
  teleport: [
    'automation.safety.fleeGoto.enabled',
    'automation.safety.fleeGoto.belowHealth',
    'automation.safety.fleeGoto.command',
    'automation.safety.retreat.belowHealth',
    'server.fleeGoto'
  ],
  'panic-call': ['automation.party.sayPanic'],
  'death-summons': { awaiting: '2026-10-11' },
  'low-lives': ['profile.lowLives'],
  reconnect: ['profile.autoReconnect'],
  'link-dead': { awaiting: '2026-10-11' },
  'realm-penalty': ['server.hangPenalties'],
  // Gear and loot
  'loot-coins': [
    'automation.loot.coins',
    'automation.loot.coinKinds',
    'automation.loot.stopAtGrade'
  ],
  'loot-hidden-coins': ['automation.loot.coins', 'automation.loot.coinKinds'],
  'loot-listed': ['automation.loot.items', 'automation.loot.maxEncumbrance'],
  'loot-stocking': [
    'automation.supplies.enabled',
    'automation.supplies.items',
    'automation.loot.maxEncumbrance'
  ],
  'loot-upgrade': ['automation.loot.upgrades'],
  'loot-worth': ['automation.loot.minPrice', 'automation.loot.maxEncumbrance'],
  'loot-not-resting': { awaiting: '2026-10-11' },
  'coin-discard': ['automation.loot.discardKinds'],
  'loot-convert': ['automation.loot.convertWith', 'automation.loot.convertAt'],
  'floor-after-kill': [
    'automation.loot.items',
    'automation.loot.minPrice',
    'automation.loot.upgrades',
    'automation.supplies.enabled'
  ],
  'gear-weighing': ['automation.combat.attack'],
  'gear-weakest-worn': { awaiting: '2026-10-11' },
  'floor-gear-check': { awaiting: '2026-10-11' },
  'floor-gear-refuse': ['automation.gear.enabled', 'automation.gear.sets'],
  'found-gear-wear': ['automation.loot.upgrades'],
  'gear-set-overlay': ['automation.gear.enabled', 'automation.gear.sets'],
  'gear-set-wear': ['automation.gear.enabled', 'automation.gear.sets'],
  'backstab-weapon': ['automation.gear.enabled', 'automation.combat.opener'],
  'reach-wield': { awaiting: '2026-10-11' },
  'off-round-use': ['automation.gear.offRound.item', 'automation.gear.offRound.everyRounds'],
  'place-gear': ['automation.gear.resists'],
  'swap-back-check': { awaiting: '2026-10-11' },
  'restore-gear': { awaiting: '2026-10-11' },
  'reequip-on-recover': ['automation.movement.reequipOnRecover'],
  'take-floor': { awaiting: '2026-10-11' },
  'gear-recovery-strip': ['automation.movement.recoverGear'],
  'gear-recovery-bounds': [
    'automation.movement.recoverGearFloor',
    'automation.movement.recoverGearTries'
  ],
  'gear-recovery-take': ['automation.movement.recoverGear'],
  'gear-lock-release': ['automation.movement.gearLockHours'],
  'drop-junk': [
    'automation.drop.enabled',
    'automation.drop.items',
    'automation.drop.whenEncumbered'
  ],
  'drop-worthless': ['automation.drop.worthless', 'automation.drop.enabled'],
  'drop-quest-keep': { awaiting: '2026-10-11' },
  'outgrown-pick': ['automation.outgrown.enabled'],
  'outgrown-kept': ['automation.supplies.items', 'automation.gear.sets'],
  'outgrown-rarity': { awaiting: '2026-10-11' },
  'outgrown-way': ['automation.outgrown.enabled', 'automation.outgrown.ganghouseRoom'],
  'ganghouse-open': ['automation.outgrown.ganghouseRoom'],
  'sell-trip': { awaiting: '2026-10-11' },
  'stash-fetch': { awaiting: '2026-10-11' },
  'chest-read': { awaiting: '2026-10-11' },
  'item-charges-look': { awaiting: '2026-10-11' },
  'auto-deposit': [
    'automation.banking.autoDeposit',
    'automation.banking.depositThresholdCopper',
    'automation.banking.keepCopper',
    'automation.banking.bank'
  ],
  withdraw: ['automation.supplies.enabled'],
  'supplies-short': ['automation.supplies.enabled', 'automation.supplies.items'],
  'supplies-buy': ['automation.supplies.items'],
  'supplies-bank': ['automation.supplies.enabled'],
  'supplies-surplus': ['automation.supplies.items'],
  'supply-counter': ['automation.supplies.items'],
  'gear-trip': { awaiting: '2026-10-11' },
  'gear-upgrades': { awaiting: '2026-10-11' },
  'best-in-slot': { awaiting: '2026-10-11' },
  'gear-worth': { awaiting: '2026-10-11' },
  'cash-run': { awaiting: '2026-10-11' },
  'sale-on-the-way': ['automation.supplies.items', 'automation.gear.sets'],
  'pack-after': { awaiting: '2026-10-11' },
  // Walking, loops and detours
  'walk-start-refuse': { awaiting: '2026-10-11' },
  'walk-step': { awaiting: '2026-10-11' },
  'walk-sneak': ['automation.movement.sneak'],
  'walk-off-round': ['automation.movement.runBetweenRounds'],
  'walk-quarry-hold': { awaiting: '2026-10-11' },
  'walk-nudge': ['automation.walk.stepTimeoutMs'],
  'walk-timeout-stop': ['automation.walk.stepTimeoutMs'],
  'walk-wrong-room': { awaiting: '2026-10-11' },
  'walk-dark-stop': { awaiting: '2026-10-11' },
  'walk-dark-hold': ['automation.movement.provideLight'],
  'walk-follow-settle': { awaiting: '2026-10-11' },
  'walk-player-took-over': { awaiting: '2026-10-11' },
  'walk-fight-hold': [
    'automation.combat.enabled',
    'automation.combat.retaliate',
    'automation.combat.engage',
    'automation.combat.mobRules'
  ],
  'walk-rest-hold': [
    'automation.health.restBelow',
    'automation.health.restTo',
    'automation.health.restBelowMana',
    'automation.health.restToMana'
  ],
  'walk-trap-rest': ['automation.health.restBeforeTraps'],
  'walk-affliction-hold': [
    'automation.movement.walkWhileBlind',
    'automation.movement.walkWhilePoisoned',
    'automation.movement.walkWhileConfused'
  ],
  'walk-move-unanswered': ['automation.walk.stepTimeoutMs'],
  'door-open': ['automation.movement.openDoors', 'automation.movement.openTries'],
  'door-pick': ['automation.movement.pickLocks', 'automation.movement.pickTries'],
  'door-bash': [
    'automation.movement.bashDoors',
    'automation.movement.bashTries',
    'automation.health.restBelow'
  ],
  'door-stop': ['automation.movement.pickLocks', 'automation.movement.bashDoors'],
  'hidden-search': { awaiting: '2026-10-11' },
  'lever-pull': { awaiting: '2026-10-11' },
  'trap-disarm': { awaiting: '2026-10-11' },
  'room-command': { awaiting: '2026-10-11' },
  'ward-use': ['automation.health.useWards'],
  'light-lit': ['automation.movement.provideLight', 'automation.movement.lightDimRooms'],
  'light-out': ['automation.movement.extinguishInLight', 'automation.movement.lightDimRooms'],
  'light-buy': ['automation.movement.provideLight', 'automation.movement.buyLight'],
  'key-pickup': ['automation.movement.collectKeys'],
  'leader-door': ['automation.party.helpWithDoors'],
  'loop-advance': ['loop.stops', 'loop.bounce'],
  'loop-dwell': ['loop.linger'],
  'loop-skip-empty': ['loop.every'],
  'loop-vitals-hold': [
    'automation.health.restBelow',
    'automation.health.restTo',
    'automation.health.restBelowMana',
    'automation.health.restToMana'
  ],
  'loop-rate-floor': ['automation.walk.minExpPerHour'],
  'loop-fail': { awaiting: '2026-10-11' },
  'loop-escape-settle': { awaiting: '2026-10-11' },
  'hunt-move': [
    'automation.hunting.enabled',
    'automation.hunting.radius',
    'automation.hunting.cashPerHour'
  ],
  'hunt-resurvey': ['automation.hunting.radius'],
  'hunt-resume-ask': { awaiting: '2026-10-11' },
  'train-level': ['automation.train.levels', 'automation.train.upTo', 'automation.train.trainer'],
  'train-stats': ['automation.train.stats', 'automation.train.pick', 'automation.train.wanted'],
  'item-collect': { awaiting: '2026-10-11' },
  'floor-collect': { awaiting: '2026-10-11' },
  'area-search': { awaiting: '2026-10-11' },
  'quest-run': ['automation.quests.enabled'],
  'travel-replan': { awaiting: '2026-10-11' },
  'party-wait': [
    'automation.party.waitBelow',
    'automation.party.waitMinutes',
    'automation.party.manageParty'
  ],
  'remote-moves': ['automation.remotes.enabled', 'automation.remotes.party'],
  'route-keep-out': ['automation.movement.keepOutOf'],
  'route-forcing': ['automation.movement.pickLocks', 'automation.movement.bashDoors'],
  'route-shun': { awaiting: '2026-10-11' },
  'route-price': { awaiting: '2026-10-11' },
  // Party and remotes
  'remote-gate': ['automation.remotes.enabled'],
  'remote-grant': [
    'automation.remotes.players',
    'automation.remotes.gang',
    'automation.remotes.party'
  ],
  'remote-refuse-standing': { awaiting: '2026-10-11' },
  'remote-gangpath': ['automation.remotes.gangpath'],
  'remote-answer': ['automation.remotes.enabled'],
  'remote-do': [
    'automation.remotes.players',
    'automation.remotes.gang',
    'automation.remotes.party'
  ],
  'remote-party-cmd': ['automation.party.ignoreParty'],
  'remote-item-commands': [
    'automation.remotes.players',
    'automation.remotes.gang',
    'automation.remotes.party'
  ],
  'remote-move': [
    'automation.remotes.players',
    'automation.remotes.gang',
    'automation.remotes.party'
  ],
  'remote-switch': ['automation.combat.enabled', 'automation.movement.sneak'],
  'remote-wait': ['automation.party.ignoreWait', 'automation.party.manageParty'],
  'remote-barrier': [
    'automation.movement.pickTries',
    'automation.movement.bashTries',
    'automation.health.restBelow'
  ],
  'party-ask-health': ['automation.party.askHealth'],
  'party-ask-heal': ['automation.party.askForHealBelow'],
  'afk-reply': ['automation.afk.enabled', 'automation.afk.reply', 'automation.afk.afterMinutes'],
  'party-autojoin': ['automation.remotes.enabled', 'automation.remotes.autoJoin'],
  'party-invite-followup': ['automation.onPartyChange'],
  'party-relay-portal': ['automation.party.relayPortals'],
  'party-regroup': ['automation.party.regroupMinutes', 'automation.onPartyChange'],
  'party-listing-clock': [
    'automation.party.parSeconds',
    'automation.party.parAfterRound',
    'automation.party.parEveryRounds',
    'automation.onPartyChange'
  ],
  'party-change': ['automation.onPartyChange'],
  'follower-wait': [
    'automation.remotes.enabled',
    'automation.health.restBelow',
    'automation.health.restBelowMana'
  ],
  'sheet-report': { awaiting: '2026-10-11' },
  // Routines and the queue
  'enter-realm-batch': ['automation.onEnterRealm'],
  'enter-realm-unread': ['automation.onEnterRealm'],
  'set-statline': ['automation.statline.control'],
  'ask-who': { awaiting: '2026-10-11' },
  'ask-abilities': { awaiting: '2026-10-11' },
  'ask-spellbook': { awaiting: '2026-10-11' },
  'ask-sheet-buff': { awaiting: '2026-10-11' },
  'aged-facts': { awaiting: '2026-10-11' },
  'stat-all': { awaiting: '2026-10-11' },
  'look-at-player': ['automation.talk.lookAtPlayers'],
  'keep-alive': [
    'automation.idle.enabled',
    'automation.idle.afterSeconds',
    'automation.idle.command'
  ],
  'login-step': ['server.login', 'connection.login.steps', 'connection.login.enabled'],
  'login-stop': ['connection.login.enabled'],
  'queue-refuse': { awaiting: '2026-10-11' },
  'queue-pacing': [
    'automation.pacing.window',
    'automation.pacing.minGapMs',
    'automation.pacing.ackTimeoutMs'
  ],
  'queue-typing-hold': { awaiting: '2026-10-11' },
  'queue-fumble-resend': { awaiting: '2026-10-11' },
  'locate-ask': ['profile.locate'],
  'stale-move-probe': { awaiting: '2026-10-11' },
  // Extensions
  'extension-load': { awaiting: '2026-10-11' },
  'extension-lay-settings': { awaiting: '2026-10-11' },
  'extension-offer': { awaiting: '2026-10-11' },
  'extension-steer-hunt': ['automation.hunting.enabled'],
  'extension-trip': { awaiting: '2026-10-11' }
} as const satisfies Record<string, DecisionSettings>;

/** A decision the client makes on its own. Closed: a new one is a row above. */
export type DecisionKind = keyof typeof DECISION_SETTINGS;

export const DECISION_KINDS = Object.keys(DECISION_SETTINGS) as readonly DecisionKind[];

/** The settings behind one decision; empty while it awaits one. */
export function settingsOf(kind: DecisionKind): readonly SettingPath[] {
  const row: DecisionSettings = DECISION_SETTINGS[kind];
  return 'awaiting' in row ? [] : row;
}
