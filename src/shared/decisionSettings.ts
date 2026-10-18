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
  | keyof Pick<AppConfig, 'extensions'>
  | `profile.${keyof Pick<Profile, 'lowLives' | 'autoReconnect' | 'reconnectTries' | 'locate'>}`
  | 'profile.login.enabled'
  | `server.${keyof Pick<Server, 'login' | 'hangPenalties' | 'fleeGoto'>}`
  | `loop.${keyof Pick<Loop, 'stops' | 'bounce'> | keyof Pick<LoopStop, 'linger' | 'every'>}`;

/**
 * The settings behind a decision, or why it has none and since when
 * (`exempt`): a rule the server enforces, the client's own bookkeeping, a
 * timeout, or a command the player started.
 */
export type DecisionSettings =
  readonly [SettingPath, ...SettingPath[]] | { readonly exempt: string; readonly since: string };

export const DECISION_SETTINGS = {
  // Combat
  'attack-master-switch': [
    'automation.combat.enabled',
    'automation.combat.retaliate',
    'automation.combat.engage'
  ],
  'mortally-wounded-stop': {
    exempt: 'the server lets a mortally wounded character do nothing',
    since: '2026-10-13'
  },
  'hit-back': [
    'automation.combat.retaliate',
    'automation.combat.mobRules',
    'automation.combat.maxMonsterExperience',
    'automation.combat.maxTargetHealth'
  ],
  'hit-back-pick': ['automation.combat.mobRules'],
  'broken-fight-owed': {
    exempt: 'bookkeeping: the fight the server broke off is still owed',
    since: '2026-10-13'
  },
  'assist-leader': ['automation.party.assistLeader'],
  'defend-party': ['automation.party.defendParty'],
  'engage-gate': [
    'automation.combat.engage',
    'automation.combat.maxMobs',
    'automation.combat.minMobs',
    'automation.combat.mobRules'
  ],
  'typed-break': {
    exempt: 'the player typed break, and a move or a typed attack releases it',
    since: '2026-10-13'
  },
  'row-stance': ['automation.combat.mobRules'],
  'polite-claim': ['automation.combat.politeAttacks', 'automation.combat.mobRules'],
  'costly-refuse': ['automation.combat.attackCostly'],
  'cannot-hurt': {
    exempt: 'the server says the wielded weapon cannot hurt it',
    since: '2026-10-13'
  },
  'weapon-swap': ['automation.combat.swapWeapons'],
  'realm-avoid': ['automation.combat.mobRules'],
  'fled-from': ['automation.combat.fledLevels', 'automation.combat.fledForgetMinutes'],
  'exp-cap': ['automation.combat.maxMonsterExperience'],
  'hp-cap': ['automation.combat.maxTargetHealth'],
  'row-not-hostile': ['automation.combat.mobRules', 'automation.combat.engage'],
  'uncertain-hostility': ['automation.combat.engage'],
  'not-hostile': ['automation.combat.engage'],
  'planned-fight': {
    exempt: 'the player chose the detour or quest that names the monster',
    since: '2026-10-13'
  },
  'guarded-refuse': ['automation.combat.mobRules'],
  'attack-target': ['automation.combat.mobRules'],
  'engage-cooldown': {
    exempt: 'a timeout against attacking one monster twice in a round',
    since: '2026-10-13'
  },
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
    'automation.spells.killConfidence',
    'automation.combat.mobRules'
  ],
  'auto-choose-spell': [
    'automation.spells.autoChoose',
    'automation.spells.attackCasts',
    'automation.spells.killConfidence'
  ],
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
  'break-area': {
    exempt: 'the server keeps casting a repeating room spell until break',
    since: '2026-10-13'
  },
  'cast-round-gate': { exempt: 'the server allows one cast a round', since: '2026-10-13' },
  'room-refresh': ['automation.combat.refreshRounds'],
  'arrival-reread': {
    exempt: 'bookkeeping: an unknown hostility is read before it is fought',
    since: '2026-10-13'
  },
  'hide-sneak': [
    'automation.combat.hideForOpener',
    'automation.combat.opener',
    'automation.combat.enabled'
  ],
  search: ['automation.search.enabled', 'automation.search.tries'],
  'unlisted-searcher': {
    exempt: 'a safety look at a player the room did not list',
    since: '2026-10-13'
  },
  'backstab-hands': {
    exempt: 'bookkeeping: what was in hand goes back after a backstab',
    since: '2026-10-13'
  },
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
  'rest-away': ['automation.health.restNextDoor', 'automation.health.restNextDoorMinutes'],
  'rest-away-back': ['automation.health.restNextDoor'],
  'rest-spell': ['automation.health.restSpell'],
  'auto-rest-back': ['automation.health.autoRest'],
  'heal-self': [
    'automation.spells.heal',
    'automation.spells.healBelow',
    'automation.spells.healBelowInCombat',
    'automation.spells.healTo',
    'automation.spells.autoChooseHeal',
    'automation.spells.healUrgency',
    'automation.spells.healMinMana'
  ],
  'heal-party': [
    'automation.spells.healParty',
    'automation.spells.healPartyWith',
    'automation.spells.healBelow',
    'automation.spells.healBelowInCombat',
    'automation.spells.autoChooseHeal',
    'automation.spells.healUrgency',
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
  'bless-choose': [
    'automation.spells.autoChooseBlessings',
    'automation.spells.blessings',
    'automation.spells.blessMinGain',
    'automation.spells.blessHealReserve',
    'automation.spells.blessSwapCommandsPerHour',
    'automation.combat.safeOddsAbove'
  ],
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
    'automation.safety.hangUp.afterRunSeconds',
    'automation.combat.mobRules',
    'server.hangPenalties'
  ],
  'hang-up-naked': ['automation.safety.hangUp.whenNaked', 'automation.safety.hangUp.nakedMargin'],
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
  'run-direction': {
    exempt: 'a fixed order, each way out safer than the next; how far to run is retreat.strategy',
    since: '2026-10-13'
  },
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
  'death-summons': {
    exempt: 'bookkeeping: a summoning monster leaves its summons on the floor',
    since: '2026-10-13'
  },
  'low-lives': ['profile.lowLives'],
  reconnect: ['profile.autoReconnect', 'profile.reconnectTries'],
  'link-dead': {
    exempt: 'a timeout: a socket silent after a command is dead',
    since: '2026-10-13'
  },
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
  'loot-not-resting': {
    exempt: 'the server stands a resting character up for a get',
    since: '2026-10-13'
  },
  'coin-discard': ['automation.loot.discardKinds'],
  'loot-convert': ['automation.loot.convertWith', 'automation.loot.convertAt'],
  'floor-after-kill': [
    'automation.loot.items',
    'automation.loot.minPrice',
    'automation.loot.upgrades',
    'automation.supplies.enabled'
  ],
  'gear-weighing': ['automation.loot.gearWeights', 'automation.combat.attack'],
  'gear-weakest-worn': ['automation.loot.gearWeights'],
  'floor-gear-check': {
    exempt: 'an item that cannot be told apart or worn is no upgrade',
    since: '2026-10-13'
  },
  'floor-gear-refuse': ['automation.gear.enabled', 'automation.gear.sets'],
  'found-gear-wear': ['automation.loot.upgrades', 'automation.loot.gearWeights'],
  'gear-set-overlay': ['automation.gear.enabled', 'automation.gear.sets'],
  'gear-set-wear': ['automation.gear.enabled', 'automation.gear.sets'],
  'backstab-weapon': ['automation.gear.enabled', 'automation.combat.opener'],
  'reach-wield': { exempt: 'the attack chosen needs the weapon in hand', since: '2026-10-13' },
  'off-round-use': ['automation.gear.offRound.item', 'automation.gear.offRound.everyRounds'],
  'place-gear': ['automation.gear.resists', 'automation.gear.resistMinSaved'],
  'swap-back-check': {
    exempt: 'bookkeeping: says when a bless swap left the wrong weapon in hand',
    since: '2026-10-13'
  },
  'restore-gear': { exempt: 'the player asked for the saved gear back', since: '2026-10-13' },
  'reequip-on-recover': ['automation.movement.reequipOnRecover'],
  'take-floor': ['automation.remotes.maxGets'],
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
  'drop-quest-keep': ['automation.drop.keepQuestItems'],
  'outgrown-pick': ['automation.outgrown.enabled', 'automation.loot.gearWeights'],
  'outgrown-kept': ['automation.supplies.items', 'automation.gear.sets'],
  'outgrown-rarity': ['automation.outgrown.keepRare'],
  'outgrown-way': [
    'automation.outgrown.enabled',
    'automation.outgrown.ganghouseRoom',
    'automation.outgrown.stashFromCopper',
    'automation.outgrown.sellFromCopper'
  ],
  'ganghouse-open': ['automation.outgrown.ganghouseRoom'],
  // Started only when an extension asks, so its switch governs them.
  'sell-trip': ['extensions'],
  'stash-fetch': ['extensions'],
  'chest-read': {
    exempt: 'the player typed the open, and its listing is part of that command',
    since: '2026-10-13'
  },
  'item-charges-look': ['automation.asks.itemUses'],
  'auto-deposit': [
    'automation.banking.autoDeposit',
    'automation.banking.depositThresholdCopper',
    'automation.banking.keepCopper',
    'automation.banking.bank'
  ],
  withdraw: ['automation.supplies.enabled', 'automation.supplies.cashBuffer'],
  'supplies-short': ['automation.supplies.enabled', 'automation.supplies.items'],
  'supplies-buy': ['automation.supplies.items'],
  'supplies-bank': ['automation.supplies.enabled', 'automation.supplies.cashBuffer'],
  'supplies-surplus': ['automation.supplies.items'],
  'supply-counter': ['automation.supplies.items', 'automation.supplies.dearerSteps'],
  'gear-trip': { exempt: 'the player started the trip', since: '2026-10-13' },
  'gear-upgrades': ['automation.loot.gearWeights'],
  'best-in-slot': ['automation.loot.gearWeights', 'automation.gear.offersPerSlot'],
  'gear-worth': ['automation.loot.gearWeights'],
  'cash-run': { exempt: 'the player started the run', since: '2026-10-13' },
  'sale-on-the-way': [
    'automation.supplies.items',
    'automation.gear.sets',
    'automation.outgrown.sellDetour',
    'automation.outgrown.sellFromCopper',
    'automation.outgrown.stashFromCopper',
    'automation.outgrown.keepRare'
  ],
  'pack-after': {
    exempt: 'bookkeeping: a give or take in a script changed the inventory',
    since: '2026-10-13'
  },
  // Walking, loops and detours
  'walk-start-refuse': {
    exempt: 'a route that cannot start is refused, never guessed',
    since: '2026-10-13'
  },
  'walk-step': { exempt: 'the server answers one step at a time', since: '2026-10-13' },
  'walk-sneak': ['automation.movement.sneak', 'automation.movement.sneakGiveUp'],
  'walk-off-round': ['automation.movement.runBetweenRounds'],
  'walk-quarry-hold': {
    exempt: 'bookkeeping: the monster it means to fight is here',
    since: '2026-10-13'
  },
  'walk-nudge': ['automation.walk.stepTimeoutMs'],
  'walk-timeout-stop': ['automation.walk.stepTimeoutMs'],
  'walk-wrong-room': {
    exempt: 'an ambiguous room is reported, never guessed',
    since: '2026-10-13'
  },
  'walk-dark-stop': { exempt: 'a dark room cannot be placed, never guessed', since: '2026-10-13' },
  'walk-dark-hold': ['automation.movement.provideLight'],
  'walk-follow-settle': { exempt: "a timeout: the leader's move lands first", since: '2026-10-13' },
  'walk-player-took-over': { exempt: 'the player typed a move', since: '2026-10-13' },
  'walk-fight-hold': [
    'automation.combat.enabled',
    'automation.combat.retaliate',
    'automation.combat.engage',
    'automation.combat.mobRules'
  ],
  'walk-rest-hold': [
    'automation.health.autoRest',
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
  'door-pick': [
    'automation.movement.pickLocks',
    'automation.movement.pickTries',
    'automation.movement.pickMargin'
  ],
  'door-bash': [
    'automation.movement.bashDoors',
    'automation.movement.bashTries',
    'automation.movement.bashMargin',
    'automation.health.restBelow'
  ],
  'door-stop': ['automation.movement.pickLocks', 'automation.movement.bashDoors'],
  'hidden-search': ['automation.movement.searchHidden'],
  'lever-pull': ['automation.movement.pullLevers', 'automation.movement.leverTries'],
  'trap-disarm': ['automation.movement.disarmTraps', 'automation.movement.disarmDoubt'],
  'room-command': {
    exempt: "the route needs the room's own command to go on",
    since: '2026-10-13'
  },
  'ward-use': ['automation.health.useWards'],
  'light-lit': ['automation.movement.provideLight', 'automation.movement.lightDimRooms'],
  'light-out': ['automation.movement.extinguishInLight', 'automation.movement.lightDimRooms'],
  'light-buy': [
    'automation.movement.provideLight',
    'automation.movement.buyLight',
    'automation.movement.carryLights'
  ],
  'key-pickup': ['automation.movement.collectKeys'],
  'leader-door': [
    'automation.party.helpWithDoors',
    'automation.movement.pickMargin',
    'automation.movement.bashMargin'
  ],
  'loop-advance': ['loop.stops', 'loop.bounce'],
  'loop-dwell': ['loop.linger'],
  'loop-skip-empty': ['loop.every'],
  'loop-vitals-hold': [
    'automation.health.autoRest',
    'automation.health.restBelow',
    'automation.health.restTo',
    'automation.health.restBelowMana',
    'automation.health.restToMana'
  ],
  // The stop names the better spot within `betterSpotRadius`.
  'loop-rate-floor': [
    'automation.walk.minExpPerHour',
    'automation.walk.expRateGraceMinutes',
    'automation.hunting.betterSpotRadius'
  ],
  'loop-fail': ['automation.walk.failedLegs'],
  'loop-escape-settle': {
    exempt: 'a timeout: the run lands before the lap goes on',
    since: '2026-10-13'
  },
  'hunt-move': [
    'automation.hunting.enabled',
    'automation.hunting.radius',
    'automation.hunting.cashPerHour',
    'automation.hunting.moveMargin',
    'automation.hunting.cashExpShare',
    'automation.hunting.maxDamageShare',
    'automation.hunting.trivialLevelMargin'
  ],
  // What the survey leaves out is what it surveys again.
  'hunt-resurvey': [
    'automation.hunting.radius',
    'automation.hunting.maxDamageShare',
    'automation.hunting.trivialLevelMargin'
  ],
  'hunt-resume-ask': ['automation.walk.resumeAskSteps'],
  'train-level': ['automation.train.levels', 'automation.train.upTo', 'automation.train.trainer'],
  'train-stats': [
    'automation.train.stats',
    'automation.train.pick',
    'automation.train.wanted',
    'automation.train.statHorizon'
  ],
  'item-collect': { exempt: 'the player asked for the item', since: '2026-10-13' },
  'floor-collect': {
    exempt: 'a command budget: no more gets than one press of the gear button, said when it bites',
    since: '2026-10-13'
  },
  'area-search': ['automation.search.areaMaxSteps', 'automation.search.areaMaxSearches'],
  'quest-run': ['automation.quests.enabled', 'automation.quests.rollTries'],
  'travel-replan': {
    exempt: 'bookkeeping: the character is off the route it planned',
    since: '2026-10-13'
  },
  'party-wait': [
    'automation.party.waitBelow',
    'automation.party.waitMinutes',
    'automation.party.manageParty'
  ],
  'remote-moves': ['automation.remotes.enabled', 'automation.remotes.party'],
  'route-keep-out': ['automation.movement.keepOutOf'],
  'route-forcing': [
    'automation.movement.pickLocks',
    'automation.movement.bashDoors',
    'automation.movement.searchHidden',
    'automation.movement.pullLevers',
    'automation.movement.disarmTraps'
  ],
  'route-shun': ['automation.movement.avoidRanFromMinutes'],
  'key-buy': ['automation.movement.buyKeys', 'automation.movement.buyKeysMaxGold'],
  'route-price': [
    'automation.movement.fightCost',
    'automation.movement.dangerCost',
    'automation.movement.anotherWayPenalty',
    'automation.movement.anotherWayLonger'
  ],
  // Party and remotes
  'remote-gate': ['automation.remotes.enabled'],
  'remote-grant': [
    'automation.remotes.players',
    'automation.remotes.gang',
    'automation.remotes.party'
  ],
  'remote-refuse-standing': [
    'automation.remotes.allowKillAndHangup',
    'automation.remotes.players',
    'automation.remotes.gang',
    'automation.remotes.party'
  ],
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
    'automation.remotes.party',
    'automation.remotes.maxGets'
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
  'party-autoinvite': ['automation.remotes.players'],
  'party-relay-portal': ['automation.party.relayPortals'],
  'party-regroup': ['automation.party.regroupMinutes', 'automation.onPartyChange'],
  'party-listing-clock': [
    'automation.party.parSeconds',
    'automation.party.parAfterRound',
    'automation.party.parEveryRounds',
    'automation.party.parAtLoss',
    'automation.onPartyChange'
  ],
  'party-change': ['automation.onPartyChange'],
  'follower-wait': [
    'automation.remotes.enabled',
    'automation.health.restBelow',
    'automation.health.restBelowMana'
  ],
  'sheet-report': [
    'automation.remotes.enabled',
    'automation.remotes.players',
    'automation.remotes.gang',
    'automation.remotes.party'
  ],
  // Routines and the queue
  'enter-realm-batch': ['automation.onEnterRealm'],
  'enter-realm-unread': ['automation.onEnterRealm'],
  'set-statline': ['automation.statline.control'],
  'ask-who': ['automation.asks.whoMinutes'],
  'ask-abilities': ['automation.asks.abilities'],
  'ask-spellbook': ['automation.asks.spellbook'],
  'ask-sheet-buff': ['automation.asks.statsOnBuffEnding'],
  'aged-facts': [
    'automation.asks.inventoryMinutes',
    'automation.asks.statsMinutes',
    'automation.asks.expMinutes'
  ],
  'stat-all': ['automation.asks.statAll'],
  'look-at-player': ['automation.talk.lookAtPlayers'],
  'keep-alive': [
    'automation.idle.enabled',
    'automation.idle.afterSeconds',
    'automation.idle.command'
  ],
  'login-step': ['server.login', 'connection.login.steps', 'profile.login.enabled'],
  'login-stop': ['profile.login.enabled'],
  'queue-refuse': {
    exempt: 'nothing goes out at the stat screen, offline or with automation off',
    since: '2026-10-13'
  },
  'queue-pacing': [
    'automation.pacing.window',
    'automation.pacing.minGapMs',
    'automation.pacing.ackTimeoutMs'
  ],
  'queue-typing-hold': { exempt: 'the player is typing a line', since: '2026-10-13' },
  'queue-fumble-resend': { exempt: 'the server refused a fumbled command', since: '2026-10-13' },
  'locate-ask': ['profile.locate'],
  'stale-move-probe': {
    exempt: 'a timeout: a move the server never answered',
    since: '2026-10-13'
  },
  // Extensions
  'extension-load': ['extensions'],
  'extension-lay-settings': ['extensions'],
  'extension-offer': ['extensions'],
  'extension-steer-hunt': ['extensions', 'automation.hunting.enabled'],
  'extension-trip': ['extensions']
} as const satisfies Record<string, DecisionSettings>;

/** A decision the client makes on its own. Closed: a new one is a row above. */
export type DecisionKind = keyof typeof DECISION_SETTINGS;

/**
 * Where a module says a line in the console, naming the decision it reports
 * where the client made one on its own: the line then carries a gear (todo 119).
 */
export type NoticeSink = (message: string, decision?: DecisionKind) => void;

export const DECISION_KINDS = Object.keys(DECISION_SETTINGS) as readonly DecisionKind[];

/** The settings behind one decision; empty where it is exempt. */
export function settingsOf(kind: DecisionKind): readonly SettingPath[] {
  const row: DecisionSettings = DECISION_SETTINGS[kind];
  return Array.isArray(row) ? (row as readonly SettingPath[]) : [];
}

/** The kind `text` names, or null for anything else: a kind crosses to the console as text. */
export function asDecisionKind(text: string): DecisionKind | null {
  return Object.hasOwn(DECISION_SETTINGS, text) ? (text as DecisionKind) : null;
}

/** A setting some decision reads: what a console line's gear can open. */
export type GoverningPath = Extract<
  (typeof DECISION_SETTINGS)[DecisionKind],
  readonly unknown[]
>[number];

/**
 * The settings a decision reads that have no field on any settings page, only
 * a line in a file (user, 2026-10-14, todo 119: no gear for these). A line
 * whose settings are all here has no gear; `setting-fields.test.ts` holds the
 * list to the fields the pages draw.
 */
export const FIELDLESS_SETTINGS: Readonly<Partial<Record<GoverningPath, string>>> = {
  'automation.rules': 'a list of guard expressions in the options file only (2026-10-14)',
  'automation.events': 'a list of guard expressions in the options file only (2026-10-14)',
  'automation.safety.retreat.cooldownMs': 'a line in the options file only (2026-10-14)',
  'loop.stops': "a loop's file, drawn on the loop builder card, not a settings page (2026-10-14)",
  'loop.bounce': "a loop's file, drawn on the loop builder card, not a settings page (2026-10-14)",
  'loop.linger': "a loop's file, drawn on the loop builder card, not a settings page (2026-10-14)",
  'loop.every': "a line in a loop's file only (2026-10-14)",
  'automation.health.autoRest':
    "the toolbar's switch, put back on at each walk, loop and connection (2026-10-16)"
};

/** The settings behind `kind` that a settings page draws a field for. */
export function fieldSettingsOf(kind: DecisionKind): readonly SettingPath[] {
  return settingsOf(kind).filter((path) => !Object.hasOwn(FIELDLESS_SETTINGS, path));
}

/** Whether a line about `kind` has a gear: some setting behind it has a field. */
export function hasSettingField(kind: DecisionKind): boolean {
  return fieldSettingsOf(kind).length > 0;
}
