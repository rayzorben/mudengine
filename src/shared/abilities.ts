/**
 * `Abil-n` / `AbilVal-n`: the realm's effect system, decoded.
 *
 * Five tables carry ten to twenty of these pairs each — `Items`, `Monsters`,
 * `Spells`, `Races` and `Classes` — and between them they are *everything* the
 * realm database says about what a thing does. A ring that grants +10 strength,
 * a monster immune to poison, a spell that heals, a race that regenerates
 * faster, a class that can pick locks: all of it is an `Abil-n` holding a
 * number from this table with its magnitude in the `AbilVal-n` beside it.
 *
 * mudengine read none of it until 2026-08-31, because the enum is written down
 * nowhere in the database and nowhere in the server source this project has.
 * It comes from `GetAbilityName` in MMUD-Explorer's `modMMudFunc.bas` — a VB6
 * database viewer for the same game whose author reverse-engineered it from a
 * live server. **That is the weakest provenance anything in this codebase has**,
 * so the rules `mudengine-wire` states for another client's source apply here
 * in full: where this and the wire disagree, the wire wins, and nothing here
 * decides anything on its own. It names a number; it does not claim to know
 * what the server does with it.
 *
 * What the shipped realm actually uses, measured rather than assumed:
 * **163 distinct ids** across `gmud20230902.mdb`, and 145 across the stock
 * `data-v1.11p.mdb`. The ids above 187 and the 1001–1119 block are GreaterMUD's
 * own extensions and are marked; three ids in the stock range mean *different
 * things* on the two engines and carry both words.
 *
 * Dependency-free, like every other module here: the build script writes the
 * numbers, `WorldGraph` reads them back, and a card names them.
 */

import type { UiLookup } from './i18n';

/** What one `Abil-n` value means. */
export interface AbilityMeaning {
  /** The stock MajorMUD name. */
  name: string;
  /** GreaterMUD's own name, where the engines disagree about this id. */
  greatermud?: string;
  /** Set where the id exists on GreaterMUD only. */
  only?: 'greatermud';
}

/**
 * Every id the enum names, stock and GreaterMUD together.
 *
 * `0` is deliberately absent: it is the realm's empty slot, and an item with
 * `Abil-3 = 0` has three abilities and not four.
 */
export const ABILITY: Readonly<Record<number, AbilityMeaning>> = {
  1: { name: 'Damage' },
  2: { name: 'AC' },
  3: { name: 'Resist-Cold' },
  4: { name: 'MaxDamage' },
  5: { name: 'Resist-Fire' },
  6: { name: 'Enslave' },
  7: { name: 'DR' },
  8: { name: 'DrainLife' },
  9: { name: 'Shadow' },
  10: { name: 'AC Blur' },
  11: { name: 'AlterEnergyLevel' },
  12: { name: 'Summon' },
  13: { name: 'Illu' },
  14: { name: 'RoomIllu' },
  15: { name: 'Alterhunger', greatermud: 'GypsyFortune' },
  16: { name: 'Alterthirst', greatermud: 'Rinaldo' },
  17: { name: 'Damage(-MR)' },
  18: { name: 'Heal' },
  19: { name: 'Poison' },
  20: { name: 'CurePoison' },
  21: { name: 'ImmuPoison' },
  22: { name: 'Accuracy' },
  23: { name: 'AffectsUndeadOnly' },
  24: { name: 'ProtEvil' },
  25: { name: 'ProtGood' },
  26: { name: 'DetectMagic' },
  27: { name: 'Stealth' },
  28: { name: 'Magical' },
  29: { name: 'Punch' },
  30: { name: 'Kick' },
  31: { name: 'Bash' },
  32: { name: 'Smash' },
  33: { name: 'Killblow' },
  34: { name: 'Dodge' },
  35: { name: 'JumpKick' },
  36: { name: 'M.R.' },
  37: { name: 'Picklocks' },
  38: { name: 'Tracking' },
  39: { name: 'Thievery' },
  40: { name: 'FindTraps' },
  41: { name: 'DisarmTraps' },
  42: { name: 'LearnSp' },
  43: { name: 'CastsSp' },
  44: { name: 'Intel' },
  45: { name: 'Wisdom' },
  46: { name: 'Strength' },
  47: { name: 'Health' },
  48: { name: 'Agility' },
  49: { name: 'Charm' },
  50: { name: 'MageBaneQuest', greatermud: 'Quest1' },
  51: { name: 'AntiMagic' },
  52: { name: 'EvilInCombat' },
  53: { name: 'BlindingLight' },
  54: { name: 'IlluTarget' },
  55: { name: 'AlterLightDuration' },
  56: { name: 'RechargeItem' },
  57: { name: 'SeeHidden' },
  58: { name: 'Crits' },
  59: { name: 'ClassOk' },
  60: { name: 'Fear' },
  61: { name: 'AffectExit' },
  62: { name: 'AlterEvilChance' },
  63: { name: 'AlterExperience' },
  64: { name: 'AddCP' },
  65: { name: 'Resist-Stone' },
  66: { name: 'Resist-Lightning' },
  67: { name: 'Quickness' },
  68: { name: 'Slowness' },
  69: { name: 'MaxMana' },
  70: { name: 'Spellcasting' },
  71: { name: 'Confusion' },
  72: { name: 'ShockShield' },
  73: { name: 'DispellMagic' },
  74: { name: 'HoldPerson' },
  75: { name: 'Paralyze' },
  76: { name: 'Mute' },
  77: { name: 'Perception' },
  78: { name: 'Animal' },
  79: { name: 'MageBind' },
  80: { name: 'AffectsAnimalsOnly' },
  81: { name: 'Freedom' },
  82: { name: 'Cursed' },
  83: { name: 'CursedMajor' },
  84: { name: 'RemoveCurse' },
  85: { name: 'Shatter' },
  86: { name: 'Quality' },
  87: { name: 'Speed' },
  88: { name: 'MaxHP' },
  89: { name: 'PunchAcc' },
  90: { name: 'KickAcc' },
  91: { name: 'JumpKAcc' },
  92: { name: 'PunchDmg' },
  93: { name: 'KickDmg' },
  94: { name: 'JumpKDmg' },
  95: { name: 'Slay' },
  96: { name: 'Encum%' },
  97: { name: 'GoodOnly' },
  98: { name: 'EvilOnly' },
  99: { name: 'AlterDRpercent' },
  100: { name: 'LoyalItem' },
  101: { name: 'ConfuseMsg' },
  102: { name: 'RaceStealth' },
  103: { name: 'ClassStealth' },
  104: { name: 'DefenseModifier' },
  105: { name: 'Accuracy2' },
  106: { name: 'Accuracy3' },
  107: { name: 'BlindUser' },
  108: { name: 'AffectsLivingOnly' },
  109: { name: 'NonLiving' },
  110: { name: 'NotGood' },
  111: { name: 'NotEvil' },
  112: { name: 'NeutralOnly' },
  113: { name: 'NotNeutral' },
  114: { name: '%Spell' },
  115: { name: 'DescMsg' },
  116: { name: 'BSAccu' },
  117: { name: 'BsMinDmg' },
  118: { name: 'BsMaxDmg' },
  119: { name: 'Del@Maint' },
  120: { name: 'StartMsg' },
  121: { name: 'Recharge' },
  122: { name: 'RemovesSpell' },
  123: { name: 'HPRegen' },
  124: { name: 'NegateAbility' },
  125: { name: 'IceSorcQuest' },
  126: { name: 'GoodQuest' },
  127: { name: 'NeutralQuest' },
  128: { name: 'EvilQuest' },
  129: { name: 'DarkDruidQuest' },
  130: { name: 'BloodChampQuest' },
  131: { name: 'SheDragonQuest' },
  132: { name: 'WereratQuest' },
  133: { name: 'PhoenixQuest' },
  134: { name: 'DaoLordQuest' },
  135: { name: 'MinLevel' },
  136: { name: 'MaxLevel' },
  137: { name: 'ShockMsg' },
  138: { name: 'RoomVisible' },
  139: { name: 'SpellImmu' },
  140: { name: 'TeleportRoom' },
  141: { name: 'TeleportMap' },
  142: { name: 'HitMagic' },
  143: { name: 'ClearItem' },
  144: { name: 'NonMagicalSpell' },
  145: { name: 'ManaRgn' },
  146: { name: 'MonsGuards' },
  147: { name: 'Resist-Water' },
  148: { name: 'TextBlock' },
  149: { name: 'Remove@Maint' },
  150: { name: 'HealMana' },
  151: { name: 'EndCast' },
  152: { name: 'Rune' },
  153: { name: 'KillSpell' },
  154: { name: 'Visible@Maint' },
  155: { name: 'DeathText' },
  156: { name: 'QuestItem' },
  157: { name: 'ScatterItems' },
  158: { name: 'ReqToHit' },
  159: { name: 'KaiBind' },
  160: { name: 'GiveTempSpell' },
  161: { name: 'OpenDoor' },
  162: { name: 'Lore' },
  163: { name: 'SpellComponent' },
  164: { name: 'EndCast%' },
  165: { name: 'AlterSpDmg' },
  166: { name: 'AlterSpLength' },
  167: { name: 'UnEquipItem' },
  168: { name: 'EquipItem' },
  169: { name: 'CannotWearLocation' },
  170: { name: 'Sleep' },
  171: { name: 'Invisibility' },
  172: { name: 'SeeInvisible' },
  173: { name: 'Scry' },
  174: { name: 'StealMana' },
  175: { name: 'StealHPtoMP' },
  176: { name: 'StealMPtoHP' },
  177: { name: 'SpellColours' },
  178: { name: 'Shadowform' },
  179: { name: 'FindTrapsValue' },
  180: { name: 'PickLocksValue' },
  181: { name: 'GHouseDeed' },
  182: { name: 'GHouseTax' },
  183: { name: 'GHouseItem' },
  184: { name: 'GShopItem' },
  185: { name: 'NoAttackIfItemNum' },
  186: { name: 'PerfectStealth' },
  187: { name: 'Meditate' },
  188: { name: 'Unique Pool', only: 'greatermud' },
  189: { name: 'Witchy Badges', only: 'greatermud' },
  190: { name: 'No Stock', only: 'greatermud' },
  200: { name: 'Mandos Quest', only: 'greatermud' },
  201: { name: 'Volums Quest', only: 'greatermud' },
  202: { name: 'CartographerQuest', only: 'greatermud' },
  203: { name: 'LoremasterQuest', only: 'greatermud' },
  204: { name: 'GuildmasterQuest', only: 'greatermud' },
  205: { name: 'DarkbaneQuest', only: 'greatermud' },
  206: { name: 'GrizzledRanger', only: 'greatermud' },
  207: { name: 'AmazonHuntress', only: 'greatermud' },
  208: { name: 'Conquest1', only: 'greatermud' },
  209: { name: 'Conquest2', only: 'greatermud' },
  210: { name: 'TarlChain', only: 'greatermud' },
  211: { name: 'MerchantCaptain', only: 'greatermud' },
  212: { name: 'TrendelQuest', only: 'greatermud' },
  213: { name: 'LucaProdigio', only: 'greatermud' },
  214: { name: 'EtherealWatcher', only: 'greatermud' },
  215: { name: 'KatoQuest', only: 'greatermud' },
  216: { name: 'GoodCheck', only: 'greatermud' },
  217: { name: 'NeutralCheck', only: 'greatermud' },
  218: { name: 'EvilCheck', only: 'greatermud' },
  220: { name: 'NagaQuest', only: 'greatermud' },
  221: { name: 'DreadWraith', only: 'greatermud' },
  222: { name: 'CourtesanQuest', only: 'greatermud' },
  1001: { name: 'GrantThievery', only: 'greatermud' },
  1002: { name: 'GrantTraps', only: 'greatermud' },
  1003: { name: 'GrantPicklocks', only: 'greatermud' },
  1004: { name: 'GrantTracking', only: 'greatermud' },
  1100: { name: 'AntiMagicNotOK', only: 'greatermud' },
  /*
   * **1101 is `MeetsReqToHit`, not `UseSpell`** — corrected 2026-09-06 against
   * `GMUDAbilities.cs`, which is the file that owns this range: these ids are
   * GreaterMUD's own extensions, so the server's constants are not one opinion
   * among several here, they are the definition.
   *
   * The client had `UseSpell` on 1101 and no entry at all for 1102, where the
   * server puts it. Five weapons in the shipped realm carry 1101 — the
   * enchanted dagger, the Spirit Dagger of Goijar and the three red iron
   * weapons — with values 1 to 3, and every one of them was being reported as
   * casting a spell. `Player.cs` reads it off the **wielded weapon** to decide
   * whether the wielder can hit at all ("new in GMUD, and allows way more
   * flexibility"), so it is a magnitude rather than the flag it was shaped as.
   */
  1101: { name: 'MeetsReqToHit', only: 'greatermud' },
  /*
   * And the real one. `UseCommand` casts `Abilities[UseSpell]` for an item
   * somebody types `use` at — which is also where a bare `CastsSp` ends up,
   * because `ItemType.cs` rewrites one into the other as it loads. No row in
   * either database on this machine carries 1102 directly for that reason; it
   * is named so that one which does is not reported as nothing.
   */
  1102: { name: 'UseSpell', only: 'greatermud' },
  /* The server spells this `ShadowHome`; `SneakCommand` reads it to decide
     whether sneaking stands a resting character up. */
  1103: { name: 'ShadowRest', only: 'greatermud' },
  1104: { name: 'AlterSpellHeal', only: 'greatermud' },
  1105: { name: 'AlterSpells', only: 'greatermud' },
  1106: { name: 'AlterSpellBuffs', only: 'greatermud' },
  1107: { name: 'NoAutoLearn', only: 'greatermud' },
  1108: { name: 'NotForPVP', only: 'greatermud' },
  1109: { name: 'Enchant', only: 'greatermud' },
  1110: { name: 'BSDR', only: 'greatermud' },
  1111: { name: 'Absorb', only: 'greatermud' },
  1112: { name: 'Patrol', only: 'greatermud' },
  1113: { name: 'VileWard', only: 'greatermud' },
  1114: { name: 'CastOnKill%', only: 'greatermud' },
  1115: { name: 'NoFirstKillDrop', only: 'greatermud' },
  1116: { name: 'AccountVerified', only: 'greatermud' },
  1117: { name: 'NotSellable', only: 'greatermud' },
  1118: { name: 'NoRandomRegen', only: 'greatermud' },
  1119: { name: 'Del@Ganghouse', only: 'greatermud' }
};

/**
 * The name for an id on a given realm, or null for one the enum does not know.
 *
 * Null rather than `"Ability 214"`: an id nothing names is a fact this client
 * does not have, and printing the number under a heading that looks like the
 * realm's own vocabulary is the same lie `WORN_SLOT` is confined to the
 * Reference card to avoid telling.
 */
export function abilityName(id: number, realm: 'greatermud' | 'other'): string | null {
  const meaning = ABILITY[id];
  if (meaning === undefined) return null;
  // A GreaterMUD-only id asked about on another engine is not an ability there.
  if (meaning.only === 'greatermud' && realm !== 'greatermud') return null;
  return realm === 'greatermud' && meaning.greatermud !== undefined
    ? meaning.greatermud
    : meaning.name;
}

/**
 * `MinLevel` — the level the realm requires before a thing may be used.
 *
 * Named here because this file is where the numbering is stated, and read by
 * `buildRealm` to lift the gate out of the undecoded pair list into a field of its own on
 * `WorldItem`. A gate that every equip check consults should not make
 * each caller re-scan twenty pairs for one id, and a bare `135` at the call
 * site is the half-read this file exists to stop.
 */
export const MIN_LEVEL_ABILITY = 135;

/**
 * `ConfuseMsg` — the `Messages` row a confusing spell prints when it throws a
 * command away (`ActionFigure.CheckConfusion`). The row's first line is the
 * sentence the character sees, so the set of these across a realm's spells is
 * the closed list of what a fumble can look like there (todo 05).
 */
export const CONFUSE_MESSAGE_ABILITY = 101;

/**
 * What a character can *do*, from the realm's own class and race rows
 * (todo 22, 2026-09-12).
 *
 * **Two sources, one answer, because the server asks one question.**
 * `GetAbility(x)` looks across every container a character has — race, class,
 * worn items, spell effects, granted — and automation asking *can this
 * character pick a lock* must ask it the same way. A Ninja has
 * `GrantPicklocks` from its class and a Gnome from its race; neither is more
 * true than the other, and a reader that consulted only one would answer no to
 * half the characters who can.
 *
 * **`null` is not `false`.** A realm with no `Classes` table, a class the file
 * does not name, a race the sheet has not printed yet — all of those are
 * *unknown*, and this returns null for them rather than an empty list, which
 * is the `magery 0` distinction the conversion already keeps: a class with
 * none states zero, and zero is an absence rather than a level. Every caller
 * here follows the standing rule that unknown is never the reassuring answer.
 *
 * Only the two *rows* deliberately: worn items and spell effects are on the
 * wire and change hourly, and a capability read off a helm would be one the
 * character loses when it takes the helm off. What a class and a race grant is
 * fixed for the life of the character, which is what makes it worth deciding
 * on.
 */
export interface Capabilities {
  /** Every pair from both rows, class first. Null when neither is known. */
  abilities: ReadonlyArray<readonly [number, number]> | null;
}

export function capabilitiesOf(
  classAbilities: ReadonlyArray<readonly [number, number]> | null | undefined,
  raceAbilities: ReadonlyArray<readonly [number, number]> | null | undefined
): Capabilities {
  if (
    (classAbilities === null || classAbilities === undefined) &&
    (raceAbilities === null || raceAbilities === undefined)
  ) {
    return { abilities: null };
  }
  return { abilities: [...(classAbilities ?? []), ...(raceAbilities ?? [])] };
}

/**
 * Whether a character holds an ability, from whichever row grants it.
 *
 * **Three-state, and the third state is the point.** `null` means the realm
 * has not said — no class row, no race row, a realm the client could not load
 * — and a caller that read it as `false` would decide a Gnome cannot pick
 * locks because the stat sheet had not arrived yet. Every reader here refuses
 * on `null` rather than acting on it.
 */
export function holdsAbility(capabilities: Capabilities, id: number): boolean | null {
  if (capabilities.abilities === null) return null;
  return capabilities.abilities.some(([which]) => which === id);
}

/** `ImmuPoison` — a Kang's, and what makes `rest` work where it otherwise would not. */
export const IMMUNE_TO_POISON_ABILITY = 21;
/** `GrantPicklocks` — a Ninja's and a Thief's by class, a Gnome's by race. */
export const PICKLOCKS_ABILITY = 1003;
/** `GrantTraps` — the same two classes, and a Gnome and a Dwarf by race. */
export const TRAPS_ABILITY = 1002;
/**
 * `ClassStealth` — what the class row grants, and the test for *can this
 * character get into the shadows at all*. A Thief carries `Stealth` (27)
 * beside it; `RaceStealth` (102) is the race's own and several races have it,
 * so this is deliberately the class's.
 */
export const CLASS_STEALTH_ABILITY = 103;

/**
 * `ShadowHome` (the server's spelling; `ShadowRest` above is this client's).
 *
 * Three commands read it and all three read it the same way — as an
 * *exemption* from standing the character up:
 *
 * - `RestCommand.cs:31` — `rest` does not `BreakStealth()`.
 * - `HideCommand.cs:20`, `SneakCommand.cs:28` — `hide` and `sneak` do not
 *   clear `Resting`.
 *
 * So it is symmetric: with it, resting and hiding do not undo each other in
 * either direction, and a character can sit down hidden and stay that way.
 */
export const SHADOW_HOME_ABILITY = 1103;

/**
 * Whether a class may rest and hide without one ending the other.
 *
 * **Read from the realm's own `Classes.Abil-n`, never from a class name.**
 * The shipped data is why: Paradigm grants it to seven classes — Missionary,
 * Ninja, Thief, Bard, Gypsy, Ranger, Mystic — and **MajorMUD's own realm
 * grants it to nobody at all**. So the realm data is already the gate the
 * reviewer asked for, and a check on the realm's *name* would be a second,
 * weaker statement of the same thing that could disagree with the file loaded.
 *
 * The family still gates it, because the *behaviour* is GreaterMUD's engine
 * rather than the data's: a MajorMUD server running a converted Paradigm
 * database would carry the column and not honour it. `null` family is not
 * `greatermud` — unknown is never the permissive answer.
 */
export function restsInTheShadows(
  abilities: ReadonlyArray<readonly [number, number]> | undefined,
  family: 'greatermud' | 'majormud' | null
): boolean {
  if (family !== 'greatermud') return false;
  return (abilities ?? []).some(([id]) => id === SHADOW_HOME_ABILITY);
}

/**
 * Whether the server will refuse `rest` because this character is poisoned.
 *
 * `RestCommand.cs:28` tests `GetAbility(Poison) == null || GetAbility(ImmuPoison) != null`
 * — so the refusal is lifted by **immunity**, which a Kang has from its race
 * (`Races.Abil-n` 21 at 100) and nothing else on the shipped realms does. A
 * Kang poisoned rests exactly as it always did, and telling one it cannot
 * would be the client inventing a refusal the server does not make (todo 22).
 *
 * `unknown` immunity does not lift the refusal: the server's test is the
 * ability's *presence*, and a race the client has not read grants nothing it
 * can name.
 */
export function poisonRefusesRest(
  capabilities: Capabilities,
  family: 'greatermud' | 'majormud' | null
): boolean {
  if (family !== 'greatermud') return false;
  return holdsAbility(capabilities, IMMUNE_TO_POISON_ABILITY) !== true;
}

/**
 * `LearnSp`: reading this item teaches the spell whose `Spells` row id sits in
 * the value beside it. 223 items carry it on the shipped realm.
 *
 * Named here for the reason above it — a bare `42` at the call site is the
 * half-read this file exists to stop — and it is one of the very few ids in
 * this table whose reading is **confirmed against the wire** rather than taken
 * on MMUD-Explorer's word. `scroll of cause harm` carries `[42, 12]` and spell
 * 12 is `harm`; `scroll of minor healing` carries `[42, 13]` and spell 13 is
 * `minor healing`. Read on the live realm 2026-09-03, the server answered
 * `You add harm to your spellbook!` and `You add minor healing to your
 * spellbook!` — the two names the data predicted, in that order.
 */
export const LEARN_SPELL_ABILITY = 42;

/**
 * The abilities that make a monster's spell dangerous, by id.
 *
 * Named here for the reason `MIN_LEVEL_ABILITY` is, and — unlike most of this
 * table — **read out of the server rather than off MMUD-Explorer's word**:
 * every one of these is a `case GMUDAbilityType.<name>` in `Spells/Spell.cs`
 * or `Abilities/GMUDAbilities.cs`, and the server's own constant names two of
 * them differently (`DamageNoMR` for id 1, `DamageWithMR` for 17, `Drain` for
 * 8). What each *does* to a player, which is what `menace.ts` weighs:
 *
 * - `damage` and `damageWithMr`: `inTargets[i].Hit(value)` on the cast and
 *   on every effect tick for the spell's duration. Only the second is scaled
 *   by the target's magic resistance.
 * - `drain`: the same, and the caster heals by it.
 * - `poison`: `Hit` on every tick for the duration — which is how a bite
 *   with `Poison 10–16, Dur 100` goes on costing for five minutes.
 * - `holdPerson`: `CheckForHoldPerson` refuses every normal exit
 *   (`Exits.cs`), and walking out is the only escape this realm has.
 * - `confusion`: `CheckConfusion` makes an action misfire on a roll.
 * - `blind`: `ActionFigure` stops showing the room while it is held.
 * - `slowness`: `MoveCommand` slows the character's moves.
 * - `fear`: `BreakCombat` and a roll to shove the target through a random
 *   exit, on every tick.
 * - `summon`: another monster, in this room, now.
 * - `teleportRoom`: the target is moved to a room it did not choose.
 * - `nonMagical`: the spell's presence flag that *exempts* it from magic
 *   resistance (`GetMagicResModifierVsTarget`), so a resist figure means
 *   nothing against a bite.
 * - `heal`: added to the target's health on every tick — and `damnation`
 *   states it as `-2`, which is a wound by another name.
 *
 * `Paralyze` (75), `Mute` (76) and `Sleep` (170) are deliberately absent:
 * the enum names them and monster spells carry them (`wrathful curse` states
 * `Mute`), but no code outside the enum reads any of the three, so on this
 * server they do nothing. Measured 2026-09-04 by grepping the server for each
 * id's constant; weighing them would be weighing a word.
 */
export const HAZARD_ABILITY = {
  damage: 1,
  drain: 8,
  summon: 12,
  damageWithMr: 17,
  heal: 18,
  poison: 19,
  fear: 60,
  slowness: 68,
  confusion: 71,
  holdPerson: 74,
  blind: 107,
  teleportRoom: 140,
  /**
   * The map half of a teleport, which the room number is meaningless without.
   *
   * Nothing weighs it — a spell that moves the character is already weighed by
   * `teleportRoom` — but `WorldGraph.resolveSpells` asks for either, because
   * an exit whose spell carries only one of the two still leaves the character
   * somewhere the exit table does not name.
   */
  teleportMap: 141,
  nonMagical: 144,
  /**
   * A realm script, which this client does not convert.
   *
   * The odd one out in this table: every other entry names something a spell
   * *does*, and this names the fact that what it does is not readable. Kept
   * here because the one thing that reads it — the router, deciding what an
   * exit's cast is worth — needs it in the same breath as the teleport it is
   * telling apart from, and a second table for one id would be two places to
   * keep a number.
   */
  textBlock: 148,
  /**
   * The spell this one hands the character when it ends.
   *
   * A chain rather than an effect, and `WorldGraph.resolveSpells` follows it
   * for that reason: `holding breath` carries nothing but this, and what it
   * ends in is `drowning`.
   */
  endCast: 151,
  /**
   * The spell this one takes *off* the character.
   *
   * The end of a timed corridor: `exit muddy water`, cast by the way up out
   * of the Muddy Underwater Passage, ends in `stop mud drown`, which kills
   * `holding breath` and `drowning`. `WorldGraph.corridorsAlong` reads it to
   * find where a spell the way in put on the character comes off again.
   */
  killSpell: 153,
  /**
   * The spell an **item** casts when it is used.
   *
   * The other odd one out beside `textBlock`: it is on `Items.Abil-n` rather
   * than on a spell's, and it is the first hop of the chain that says an item
   * can be a *way into* somewhere — a potion of levitation casts spell 607,
   * whose text block is `teleport 1009 9`, which is the only entrance the
   * Catacombs have. See `landingsOfItems`.
   */
  castsSpell: 43
} as const;

/**
 * A monster's own dodge, in points — its `Abil-n = 34` slot
 * (`Mobs/MobType.cs:169`). The one ability the *character's* side of the
 * arithmetic reads off a monster: `prowess.swing` turns a fraction of landed
 * blows away by it, through the same diminishing-returns curve the server
 * applies to a player's dodge.
 */
export const DODGE_ABILITY = 34;

/**
 * `Prev` (24) and `Prgd` (25): protection from evil and from good, which
 * `Mob.DoCombat` adds to the armour class of a player an evil or a good
 * monster swings at, ten internal points for each (`menace.protectionOf`).
 */
export const PROTECTION_ABILITY = { evil: 24, good: 25 } as const;

/**
 * The abilities worth putting on a card, and what each one *is*.
 *
 * The enum names 235 ids and a card that listed all of them would be a table
 * dump — the failure `ItemKind` already exists to prevent. These are the ones
 * whose value a player acts on: a stat bonus that changes what to wear, a
 * resistance that changes what to fight, a restriction that decides whether an
 * item can be equipped at all.
 *
 * Grouped, because the groups are how a card lays them out and because the
 * group says how to *read the number*: a `stat` value is a flat bonus, a
 * `percent` value is a percentage, and a `flag` has no meaningful value at all.
 */
export type AbilityShape =
  | 'stat'
  | 'percent'
  | 'points'
  | 'flag'
  | 'reference'
  /**
   * The value is a row id in `Classes` — the realm saying which classes may use
   * the item, one pair per class.
   *
   * Its own shape rather than `reference`, because a `reference` is drawn as a
   * bare `#12` and a class *can* be named: the table is fifteen rows and rides
   * on the lookup (`WorldLookup.classNames`). `#12` under a heading called
   * `ClassOk` is the number the client half-read, which is the thing the
   * "cannot read" counter exists to be honest about rather than to disguise.
   */
  | 'class'
  /**
   * The row's *presence* is the fact; its value is a bonus that is often zero.
   *
   * Races and classes state what a character can do this way, and it is
   * neither of the two shapes items needed. Not `flag`, whose zero means
   * **no** — `LoyalItem 0` is the realm denying an item is loyal — because
   * here zero means **yes, with no bonus**: all fifteen classes carry
   * `Bash 0`, and `ClassStealth 0` names exactly the seven classes that have
   * stealth at all. Not `points` either, which would draw `Bash +0` and invite
   * the reading that the class is somehow worse at it than one with no row.
   *
   * Measured rather than assumed (2026-08-31, `gmud20230902`):
   * `GrantThievery` is on Thief, Bard and Gypsy and nobody else,
   * `GrantTracking` on Ninja and Ranger, `RaceStealth` on the six stealthy
   * races. The row is the grant, and the realm attaches a number when the
   * grant comes with one — `Thief` carries `GrantPicklocks 10` where
   * `Missionary` carries `GrantPicklocks 0`.
   *
   * So it draws as its label alone at zero, and label-with-number otherwise.
   */
  | 'grant';

/**
 * How to read `AbilVal-n` for the ids a card shows.
 *
 * Absent means the id is known by name and nothing here claims to know what
 * its number means — which is honest, and is most of the table.
 */
export const ABILITY_SHAPE: Readonly<Record<number, AbilityShape>> = {
  // Combat numbers, flat.
  /*
   * `Damage` is the one id in this group that is a *kind* rather than a
   * magnitude, and it took the spell rows arriving to show it: 303 of the 324
   * spells carrying it state no value, because a damage spell's numbers are in
   * its own `MinBase`/`MaxBase`. It is on two monsters and no item at all, so
   * nothing loses a figure by this — and the 21 spells that do state one still
   * draw it. See the damage-family note further down.
   */
  1: 'grant', // Damage
  2: 'points', // AC
  4: 'points', // MaxDamage
  7: 'points', // DR
  22: 'points', // Accuracy
  105: 'points', // Accuracy2
  106: 'points', // Accuracy3
  104: 'points', // DefenseModifier
  116: 'points', // BSAccu
  117: 'points', // BsMinDmg
  118: 'points', // BsMaxDmg
  58: 'percent', // Crits
  158: 'points', // ReqToHit
  // Resistances and magic.
  3: 'percent', // Resist-Cold
  5: 'percent', // Resist-Fire
  65: 'percent', // Resist-Stone
  66: 'percent', // Resist-Lightning
  147: 'percent', // Resist-Water
  36: 'points', // M.R.
  99: 'percent', // AlterDRpercent
  // The six statistics, which is why a loadout is worth comparing at all.
  44: 'stat', // Intel
  45: 'stat', // Wisdom
  46: 'stat', // Strength
  47: 'stat', // Health
  48: 'stat', // Agility
  49: 'stat', // Charm
  // Pools and regeneration.
  69: 'points', // MaxMana
  88: 'points', // MaxHP
  123: 'percent', // HPRegen
  145: 'percent', // ManaRgn
  // Skills.
  27: 'points', // Stealth
  34: 'points', // Dodge
  37: 'points', // Picklocks
  38: 'points', // Tracking
  39: 'points', // Thievery
  40: 'points', // FindTraps
  41: 'points', // DisarmTraps
  70: 'points', // Spellcasting
  77: 'points', // Perception
  // Speed, which multiplies swings — see `SWINGS_PER_ROUND` in `combat.ts`.
  67: 'percent', // Quickness
  68: 'percent', // Slowness
  87: 'points', // Speed
  96: 'percent', // Encum%
  // Gates and flags, whose value is not a magnitude.
  51: 'flag', // AntiMagic
  57: 'percent', // SeeHidden
  82: 'flag', // Cursed
  83: 'flag', // CursedMajor
  97: 'flag', // GoodOnly
  98: 'flag', // EvilOnly
  110: 'flag', // NotGood
  111: 'flag', // NotEvil
  112: 'flag', // NeutralOnly
  113: 'flag', // NotNeutral
  /*
   * Graded on every table, and a `flag` until 2026-08-31: `ImmuPoison` runs 0,
   * 1, 7, 20, 30, 99, 100 and 999 across 409 rows, `SeeHidden` 0, 1, 99, 100
   * across 270. A zero is then the real statement *resists no poison* rather
   * than the realm declining to answer, and a bare `ImmuPoison` on a monster
   * with 7% would have promised immunity it does not have.
   */
  21: 'percent', // ImmuPoison
  /*
   * Freedom from paralysis, and a grant on every table rather than a yes/no:
   * 23 of the 24 rows that state it state **zero** — all 8 spells (the one
   * named `freedom` among them, whose only pair this is) and 15 of the 16
   * monsters. `Mayor Delanon` alone carries a 1.
   *
   * As a `flag` this deleted the spell `freedom`'s entire effects row: read
   * correctly, drawn nowhere, and never reaching the counter either. See
   * `abilityShape` for the measured rule that catches this class of error.
   */
  81: 'grant', // Freedom
  171: 'flag', // Invisibility
  172: 'flag', // SeeInvisible
  186: 'flag', // PerfectStealth
  135: 'points', // MinLevel
  136: 'points', // MaxLevel
  /*
   * The unarmed attacks, which are a whole build on this realm.
   *
   * Six ids, all flat, and all of them were counted as unreadable until
   * 2026-08-31 — so a monk's gauntlets said `+2 more the client cannot read`
   * about the two numbers that were the reason to wear them.
   */
  92: 'points', // PunchDmg
  89: 'points', // PunchAcc
  93: 'points', // KickDmg
  90: 'points', // KickAcc
  94: 'points', // JumpKDmg
  91: 'points', // JumpKAcc
  /*
   * Skills whose value is the figure the realm checks a roll against, rather
   * than a bonus to one. Named apart from `Picklocks`/`FindTraps` above by the
   * enum itself, and drawn the same way: a number a player compares.
   */
  180: 'points', // PickLocksValue
  179: 'points', // FindTrapsValue
  /*
   * How magical a thing is, 1–6 in the shipped realm.
   *
   * **Not a flag**, which is what it looks like from the name and is how it
   * would have been declared from memory: 852 items carry it and the values run
   * 1 through 6 (measured against `gmud20230902` on 2026-08-31), so it is a
   * tier. Drawn as a flat number rather than named, because nothing this
   * project has says what the six tiers are called.
   */
  28: 'points', // Magical
  /*
   * Light, which is the difference between reading a room and dead reckoning
   * through it. Graded and signed — the realm writes −25 as readily as 100 —
   * so it is a magnitude and never a flag.
   */
  13: 'points', // Illu
  14: 'points', // RoomIllu
  9: 'points', // Shadow
  /* Alignment protections, flat, and the pair of `ProtEvil`/`ProtGood`. */
  24: 'points', // ProtEvil
  25: 'points', // ProtGood
  /* Defence a player compares against another item's. */
  10: 'points', // AC Blur
  72: 'points', // ShockShield
  86: 'points', // Quality
  142: 'points', // HitMagic
  165: 'points', // AlterSpDmg
  /* Charges, which decide whether an item is worth carrying a second day. */
  121: 'points', // Recharge
  /* Which classes may use it at all — see the `class` shape. */
  59: 'class', // ClassOk
  /*
   * GreaterMUD's own, and all five are things a player acts on. Named only on
   * that engine — `abilityName` returns null for a `greatermud`-only id asked
   * about elsewhere, so a stock realm counts them as unread as before.
   */
  1108: 'flag', // NotForPVP
  // A magnitude the server compares against, not a yes/no: the five weapons
  // carrying it in the shipped realm state 1, 2 and 3.
  1101: 'points', // MeetsReqToHit
  1102: 'reference', // UseSpell — the value is a `Spells` row
  1113: 'percent', // VileWard
  1114: 'percent', // CastOnKill%
  /*
   * Whether the item stays with its owner: a yes/no, not a magnitude, and
   * the server reads it by presence (`Player.cs:3068`, `:6461`), so the 96
   * Paradigm items carrying it as zero are loyal too — see `abilityIsUnread`.
   */
  100: 'flag', // LoyalItem
  138: 'flag', // RoomVisible
  /*
   * The server's own maintenance cycle, which a player *does* act on: an item
   * that vanishes at maintenance is one not worth banking, and the realm says
   * so on 476 items in Paradigm and 348 in stock.
   *
   * Left unshaped until 2026-08-31 and therefore counted as unreadable, which
   * is what put `+1 more the client cannot read` on `spiked gauntlets` — whose
   * only unshaped pair was `Del@Maint 0`. Until 2026-09-17 that zero was read
   * as the realm promising the gauntlets are *kept*, which the server's own
   * source says is wrong: `RoomManager.DoCleanup` poofs an item whose type
   * `Abilities[DelAtMaint] != null`, and `ItemType.cs:165` loads every slot
   * whose id is non-zero whatever its value. Presence is the claim (see
   * `abilityIsUnread`); 446 of the 476 carry it as zero and every one of them
   * goes at cleanup. `waterskin` and `cup of tea` carry it as 646, and go too.
   */
  119: 'flag', // Del@Maint
  149: 'flag', // Remove@Maint
  154: 'flag', // Visible@Maint
  /*
   * Two more yes/no rows, one item each in the shipped realm and both zero —
   * `winged sandals` do not shatter, `darkwood ring` affects no exit. Shaped
   * so that the zero is read as the answer it is rather than as a fact the
   * client could not read.
   */
  85: 'flag', // Shatter
  61: 'flag', // AffectExit
  /*
   * How far a light source reaches — `torch` 100, `lantern` 175, and 999 on
   * the two that never run out. A graded magnitude a player compares before
   * walking into the dark, and it was the only light id of the four left
   * unshaped when `Illu`, `RoomIllu` and `Shadow` were added.
   */
  54: 'points', // IlluTarget
  /*
   * The gang-house economy, which is real and player-facing: the fourteen
   * parchment deeds each carry which house they buy (`GHouseDeed`), what it
   * holds (`GHouseItem`), what its shop stocks (`GShopItem`) and the tax it
   * charges (`GHouseTax`, 250 to 4,000). A deed whose card showed only its
   * price and `+4 more the client cannot read` was hiding the entire reason to
   * buy one.
   *
   * `points` rather than `reference`: the house numbers run 1 to 14 and are
   * the realm's own ordinal for a house, and nothing this project has holds a
   * table of house names to turn them into words.
   */
  181: 'points', // GHouseDeed
  182: 'points', // GHouseTax
  183: 'points', // GHouseItem
  184: 'points', // GShopItem
  /* GreaterMUD's own, on four items: which pool of uniques the drop counts against. */
  188: 'points', // Unique Pool
  /*
   * ── What a race or a class grants ────────────────────────────────────────
   *
   * Read off `Races` and `Classes`, which carry `Abil-n` pairs exactly as
   * items do and which the client showed *nothing* of until 2026-08-31: the
   * four detail cards drew their own columns and never the effect rows, so a
   * Thief's stealth and a Mystic's unarmed attacks were in the shipped realm
   * and on no screen. See the `grant` shape for why presence rather than
   * value is the fact these state.
   */
  102: 'grant', // RaceStealth
  103: 'grant', // ClassStealth
  31: 'grant', // Bash
  /*
   * The three unarmed attacks *as grants*, which is a different fact from the
   * six `PunchAcc`/`PunchDmg` numbers above: `Punch` says the Mystic has the
   * attack at all, `PunchDmg` says how hard. The Mystic is the only class
   * carrying all three, and `demigod's ring` the only item.
   */
  29: 'grant', // Punch
  30: 'grant', // Kick
  35: 'grant', // JumpKick
  1001: 'grant', // GrantThievery
  1002: 'grant', // GrantTraps
  1003: 'grant', // GrantPicklocks
  1004: 'grant', // GrantTracking
  1103: 'grant', // ShadowRest
  /*
   * ── What a monster is ────────────────────────────────────────────────────
   *
   * `NonLiving` and `Animal` decide whether a spell touches it at all —
   * `AffectsLivingOnly` is on 87 spells — so they are the difference between a
   * spell working and a round wasted. Both are 0/1 on the shipped realm and
   * both mean *yes* by presence, like the grants: `NonLiving 0` is on 364
   * monsters and a skeleton is not alive.
   *
   * `Animal` also carries a 4, on a handful of rows. Drawn as the number the
   * realm stated rather than folded to a yes — a grant prints its value when
   * it has one, which is exactly the honest answer for a value nothing here
   * can name.
   */
  109: 'grant', // NonLiving
  78: 'grant', // Animal
  /*
   * `MonsGuards` is the monster it calls for help, by row number — 251 of them
   * and the values run to 2,775, which is the `Monsters` table's own range. A
   * `reference`, drawn as `#111`: unlike `ClassOk` there are 1,800 rows and no
   * table of them rides on the lookup, so the number is all the client honestly
   * has.
   */
  146: 'reference', // MonsGuards
  /* Which ability it cancels, by id — the enum's own numbering. */
  124: 'reference', // NegateAbility
  /* Two more a fight turns on, one monster each on the shipped realm. */
  79: 'grant', // MageBind
  8: 'points', // DrainLife
  /*
   * ── What a spell does ────────────────────────────────────────────────────
   *
   * 1,985 of the realm's 1,990 spells carry effects and the client drew none
   * of them: a spell card said its level, mana and duration, and never what
   * casting it actually does.
   *
   * The ones below are the additions; the ~70 ids spells share with items were
   * already shaped and start working the moment the rows reach the card.
   */
  /*
   * The effect ids whose magnitude is **not** in `AbilVal-n`.
   *
   * `minor healing` carries `Abil-0 = Heal` with no value at all, and heals
   * 2–8: the amount is in the spell's own `MinBase`/`MaxBase` columns and the
   * ability row only says *what kind* of effect it is. Measured against
   * `gmud20230902` (2026-08-31): `Damage(-MR)` is zero on **all 316** spells
   * that carry it, `Damage` on 94% and `Heal` on 82% — while `AC` is zero on
   * only 15% and `Dodge` on 13%, which is what says the two groups are
   * genuinely different and not one convention applied unevenly.
   *
   * So they are `grant`s: the row's presence is the fact, and `Heal 0` drawn
   * as a magnitude would tell somebody a healing spell heals nothing. Where a
   * value *is* stated it still draws, which is the honest half of the same
   * rule — `globe of invulnerability` heals 9999.
   */
  17: 'grant', // Damage(-MR)
  18: 'grant', // Heal
  150: 'grant', // HealMana
  20: 'grant', // CurePoison
  73: 'grant', // DispellMagic
  19: 'grant', // Poison
  60: 'points', // Fear
  71: 'points', // Confusion
  74: 'points', // HoldPerson
  107: 'grant', // BlindUser
  108: 'grant', // AffectsLivingOnly
  23: 'grant', // AffectsUndeadOnly
  80: 'grant', // AffectsAnimalsOnly
  144: 'grant', // NonMagicalSpell
  6: 'grant', // Enslave
  76: 'grant', // Mute
  95: 'grant', // Slay
  84: 'grant', // RemoveCurse
  161: 'grant', // OpenDoor
  52: 'points', // EvilInCombat
  164: 'percent', // EndCast%
  /*
   * Where a spell puts you. `TeleportRoom` is a room number and `TeleportMap`
   * the map it is on — the pair is a destination, and 67 spells state one.
   * References rather than points: they are row ids, and printing `#1123` says
   * the client holds a number it has not looked up.
   */
  140: 'reference', // TeleportRoom
  141: 'reference', // TeleportMap
  /* What it summons, by monster row — 212 spells, `hydra head create` and kin. */
  12: 'reference', // Summon
  /* Which spell it ends outright, by id. */
  153: 'reference', // KillSpell
  /*
   * The last of what the four tables use, and each one is a fact somebody
   * looking the thing up wants: `GypsyFortune` is what makes the 26 tarot
   * cards tarot cards, `Enchant` names the fourteen enchantment spells,
   * `NoAutoLearn` is why the ten `form of the …` spells must be sought out,
   * and `Absorb` is what the four barrier spells do.
   *
   * `Rinaldo` and `GypsyFortune` are the same two ids stock MajorMUD calls
   * `Alterthirst` and `Alterhunger` — `abilityName` already picks the right
   * word per engine, so one shape serves both readings.
   */
  15: 'grant', // GypsyFortune / Alterhunger
  16: 'grant', // Rinaldo / Alterthirst
  26: 'grant', // DetectMagic
  1109: 'grant', // Enchant
  1107: 'grant', // NoAutoLearn
  1111: 'grant', // Absorb
  /*
   * Which patrol route it walks, on nine named monsters — a sheriff, a mayor,
   * the shadowmere guards. A `reference` because the value is a route number
   * and nothing here holds the routes: `#12` says the client has a number it
   * has not looked up, which is true and is the honest half of the counter.
   */
  1112: 'reference', // Patrol
  // A value that is another row's id rather than a magnitude.
  56: 'reference', // RechargeItem
  43: 'reference', // CastsSp
  42: 'reference', // LearnSp
  114: 'reference', // %Spell
  139: 'reference', // SpellImmu
  122: 'reference', // RemovesSpell
  160: 'reference', // GiveTempSpell
  185: 'reference' // NoAttackIfItemNum
  /*
   * Deliberately absent, and the last two ids the shipped realm uses that this
   * client will not draw: `ShockMsg` (137, eight items) and `Shadowform` (178,
   * one). Both carry a four-digit number — 3051 on `spiked shield`, 9652 on
   * `death shroud` — and it resolves against nothing this project has. It is
   * not a spell id, not an item id, and not a `TBInfo` textblock: every one of
   * those values falls in a gap in that table's numbering (checked against
   * `gmud20230902`, 2026-08-31). A `reference` shape would print `#3051`,
   * which is the client half-reading a fact it does not hold, so they stay
   * counted rather than named. When a capture shows what the server actually
   * says when a spiked shield fires, this is the one line that reads them.
   */
};

/**
 * Ids that are the server talking to itself, and are neither drawn nor counted.
 *
 * A third answer, and it exists because the first two were both wrong for
 * these. They are not *drawn* — nobody standing in a shop acts on which
 * textblock the server emits when a spell lands. But counting them as `+N more
 * the client cannot read` is a false confession of the same kind a zero-valued
 * flag was: the client is not failing to read them, it has read them and
 * decided they are not about the player.
 *
 * It matters at scale. When the spell rows first reached a card (2026-08-31),
 * **66.9% of the realm's 1,984 spells** carried at least one of these, so
 * nearly every spell would have ended with a confession about the server's
 * message plumbing — noise that teaches a reader to ignore the counter, which
 * costs the two ids that genuinely mean something.
 *
 * The five message ids were checked against `TBInfo` before being put here,
 * because the obvious reading is that a `DescMsg` names a textblock and could
 * simply be looked up. It does not: only 53–73% of the values are numbers that
 * table has at all, and the ones that hit resolve to a NUL byte or to somebody
 * else's script (`weapon major bless` → `takeitem 1736 3222…`). The overlap is
 * a dense numbering coinciding, not a reference.
 *
 * Anything whose player-facing meaning is later shown by a capture comes out of
 * here and gets a shape instead.
 */
export const ABILITY_INTERNAL: ReadonlySet<number> = new Set([
  115, // DescMsg — 735 spells
  148, // TextBlock — 360
  120, // StartMsg — 356
  151, // EndCast — 168
  101, // ConfuseMsg — 107
  152, // Rune
  157 // ScatterItems — the realm's own cleanup spells
]);

/**
 * Whether this id is one a card should draw, given the shape table above.
 *
 * The test is *"would a player act on the number"*, which is what keeps the
 * item detail a readout rather than a dump of the row.
 */
export function abilityIsNotable(id: number, table: AbilityTable): boolean {
  return abilityShape(id, table) !== undefined;
}

/**
 * Which table a row came off, because three ids mean different things by table.
 *
 * The realm reuses an `Abil-n` id across its five tables and does **not**
 * always keep one convention for it. `GoodOnly` on a *spell* is the realm
 * naming the fifteen good-only spells, one row each, every value zero; on an
 * *item* the same id carries a magnitude (`golden braided belt` states -51,
 * `hellblade` 250 for `EvilOnly`). One shape for both is wrong for one of them.
 */
export type AbilityTable = 'item' | 'mob' | 'spell' | 'race' | 'class';

/**
 * Ids whose shape depends on which table the row came off.
 *
 * **The test is measured, not read off the name**: an id that is *never once*
 * nonzero in a table cannot be using zero to mean "no", because the realm
 * would then have no way to say yes. Where that holds the row is a `grant` —
 * its presence is the fact — and where the table does state values it keeps
 * whatever `ABILITY_SHAPE` says.
 *
 * This existed as a defect for the length of one review. `flag`'s zero-means-no
 * rule was measured on `Items` alone (`LoyalItem`, `Del@Maint`) and left
 * untouched when the other four tables were wired in on 2026-08-31 — so the
 * claim test of the time (since removed: a flag claims by presence now)
 * dropped, silently and without even reaching the "cannot read" counter:
 *
 * - **303 spells rendered no effects row at all**, the spell literally named
 *   `freedom` among them: its only pair is `Freedom 0`, which is the realm
 *   saying what the spell *does*.
 * - `AntiMagic` on the Witchunter and on 35 monsters including every
 *   `inquisitor` — 44 rows realm-wide and not one of them nonzero.
 * - `GoodOnly`/`EvilOnly`/`NotEvil`/`NeutralOnly` on 61 spells, which is the
 *   alignment gate deciding whether a character can cast the thing at all.
 *
 * Every entry below is one measurement against `gmud20230902`, with the count
 * that justifies it.
 */
const BY_TABLE: ReadonlyArray<{
  readonly id: number;
  readonly tables: ReadonlySet<AbilityTable>;
  /** `undefined` withdraws the shape for this table: read it as unreadable. */
  readonly shape: AbilityShape | undefined;
}> = [
  // 44 rows across monsters and classes, every one of them zero.
  { id: 51, tables: new Set<AbilityTable>(['mob', 'class']), shape: 'grant' },

  /*
   * Graded on monsters, and not a yes/no at all there: `ImmuPoison` runs
   * 0, 1, 7, 30, 99, 100 and 999 across 399 rows and `SeeHidden` 0, 1, 99, 100
   * across 265. A zero is then a real statement — *this monster resists no
   * poison* — rather than the realm declining to answer, which is what makes
   * the item reading (`flag`) wrong here in the opposite direction to
   * `AntiMagic`: not a fact hidden, but a fact mis-typed.
   */

  /*
   * And graded on *items* too, which the first pass also got wrong in the
   * other direction. `ImmuPoison` is 20 on the five demonhide pieces and 100
   * on the `golden headdress` — a resistance a player compares, never a
   * yes/no. `EvilOnly` runs 0 to 300 across 59 items with 47 of them nonzero,
   * and `Cursed` and `NotGood` likewise carry 100 and 200.
   *
   * Found by the out-of-range rule rather than by reading: once a flag holding
   * neither 0 nor 1 started reaching the counter, 43 items began confessing —
   * which is the counter working, and the honest answer to it is the right
   * shape rather than a wider tolerance.
   */
  { id: 98, tables: new Set<AbilityTable>(['item']), shape: 'points' },
  { id: 97, tables: new Set<AbilityTable>(['item']), shape: 'points' },
  { id: 82, tables: new Set<AbilityTable>(['item']), shape: 'points' },
  { id: 110, tables: new Set<AbilityTable>(['item']), shape: 'points' },
  /*
   * The four alignment gates, on spells only. 61 spell rows and not one states
   * a value; the item rows of the same ids do (`hellblade` 250), which is
   * exactly why this is per table and not per id.
   */
  { id: 97, tables: new Set<AbilityTable>(['spell']), shape: 'grant' },
  { id: 98, tables: new Set<AbilityTable>(['spell']), shape: 'grant' },
  { id: 110, tables: new Set<AbilityTable>(['spell']), shape: 'grant' },
  { id: 111, tables: new Set<AbilityTable>(['spell', 'item']), shape: 'grant' },
  { id: 112, tables: new Set<AbilityTable>(['spell', 'item']), shape: 'grant' },
  { id: 113, tables: new Set<AbilityTable>(['item']), shape: 'grant' },
  // All-zero wherever they appear at all: 2, 16, 2 and 1 rows respectively.
  { id: 83, tables: new Set<AbilityTable>(['item']), shape: 'grant' },
  { id: 154, tables: new Set<AbilityTable>(['item']), shape: 'grant' },
  { id: 85, tables: new Set<AbilityTable>(['item', 'spell']), shape: 'grant' },
  { id: 61, tables: new Set<AbilityTable>(['item']), shape: 'grant' },
  /*
   * `ClassOk` on the `Classes` table itself, which is incoherent as the name
   * reads: a class does not restrict which classes may use it. One row states
   * it — `Druid`, value 74 — and the realm has fifteen classes numbered 1 to
   * 15, so 74 names none of them.
   *
   * `undefined` rather than a shape, which puts it in the "cannot read"
   * counter. Drawn as `class` it fell through to a bare `#74`, which is
   * precisely the half-read the `class` shape was introduced to stop — its own
   * doc says `#12` under a `ClassOk` heading is the thing the counter exists to
   * be honest about. What the pair means on a class row is unknown, and
   * unknown is what the counter says.
   */
  { id: 59, tables: new Set<AbilityTable>(['class']), shape: undefined }
];

/**
 * How to read a pair, given the table it came off.
 *
 * `ABILITY_SHAPE` is the answer for all but a dozen ids; `BY_TABLE` overrides
 * it where the realm's own convention differs by table, and says why for each.
 */
export function abilityShape(id: number, table: AbilityTable): AbilityShape | undefined {
  for (const entry of BY_TABLE) {
    if (entry.id === id && entry.tables.has(table)) return entry.shape;
  }
  return ABILITY_SHAPE[id];
}

/**
 * Whether a pair is one the client holds and cannot read — the honest count.
 *
 * An id with no shape is *not understood*. Every shaped pair is read, and a
 * `flag`'s value is not part of the reading: **a flag claims by presence,
 * whatever its value says** (2026-09-17, todo 01). The server settles it —
 * `AbilityContainer.this[id]` answers the row or null, `ItemType.cs:165`
 * loads any slot with a non-zero id and keeps the value beside it, and every
 * place the server asks about a flag asks `!= null`: `LoyalItem` in
 * `Player.cs:3068`, `DelAtMaint` in `RoomManager.DoCleanup`, `RemoveAtMaint`
 * in `GMUDServer.DoCleanup`. `RoomVisible` and `VisibleAtMaint` are read
 * nowhere in it.
 *
 * Until then a flag at zero was read as the realm answering *no*, measured
 * off the data's shape alone: 96 of 119 `LoyalItem` rows and 446 of 476
 * `Del@Maint` rows in Paradigm carry a zero. Read that way, 446 items that
 * go at cleanup were drawn as kept. A realm author spends a scarce slot to
 * state a flag, never to state its default, which is what the numbers were
 * saying all along. `Del@Maint 646` on `waterskin` is the same presence.
 */
/**
 * Whether a shape's value is a *magnitude* — a number the reader compares —
 * rather than a kind, a flag or a row id.
 *
 * The one place this matters is a spell that states its own power: there, a
 * magnitude of zero is the realm saying *the amount is in my own columns*,
 * not saying zero. `way of the owl` is `M.R.` with `AbilVal 0` and a power of
 * 10, and the card drew `M.R. 0` about a spell that grants ten. See
 * `WorldSpell.power` and `SpellDetail`.
 */
export function abilityIsMagnitude(shape: AbilityShape | undefined): boolean {
  return shape === 'points' || shape === 'percent' || shape === 'stat';
}

export function abilityIsUnread(id: number, table: AbilityTable): boolean {
  return abilityShape(id, table) === undefined;
}

/* ──────────────────────────────────────────────── the pairs, as a reading */

/** One effect, named and worded: what a surface draws without deciding anything. */
export interface ReadEffect {
  id: number;
  /** The realm's own word for it, from `abilityName`. */
  label: string;
  /** The magnitude as it is drawn — empty for a flag, whose presence is the fact. */
  value: string;
}

/**
 * Every `[id, value]` pair a row states, read into words — and how many it
 * could not read.
 *
 * **One reading, because there are two surfaces.** The Reference card drew
 * this and the console's own rewrites now want the same answer for an item in
 * the pack (`{item.effects}`, todo 14), and a second transcription of these
 * rules would be a second set of judgements about the realm's weakest-sourced
 * table: which ids are the server talking to itself, which values are claims
 * and which are silence, and which end of a disagreement to believe. Pure and
 * here, so the card and the drawn line cannot differ about what a ring does.
 *
 * `quiet` is the count of pairs the client holds and cannot read — an id the
 * enum has no word for on this realm, or a value its shape does not explain.
 * Saying how many is more honest than either naming them under a heading that
 * implies they were understood or pretending the thing has only the effects
 * that happened to decode.
 */
export function readEffects(
  pairs: ReadonlyArray<readonly [number, number]>,
  options: {
    table: AbilityTable;
    /** The realm on the other end; `abilityName` words three ids differently. */
    family: 'greatermud' | 'other';
    /** The realm's class table, for an ability whose value is a class id. */
    classNames?: Record<number, string>;
    /**
     * This row states its magnitude in columns of its own, so a zero here is
     * not the number. Only a spell sets it. See `EffectRows`.
     */
    magnitudeElsewhere?: boolean;
  },
  t: UiLookup
): { shown: ReadEffect[]; quiet: number } {
  const { table, family, classNames = {}, magnitudeElsewhere = false } = options;
  /*
   * Collected by id, because the realm states a *set* as one pair per member:
   * `staff-sling` carries `[[59, 12], [59, 5]]`, which is "usable by Mage, and
   * by Priest" — two rows of one fact. A `Map`, so the order is the realm's.
   */
  const collected = new Map<number, number[]>();
  let quiet = 0;
  for (const [id, value] of pairs) {
    // The server talking to itself, drawn nowhere and confessed to nowhere.
    if (ABILITY_INTERNAL.has(id)) continue;
    if (abilityName(id, family) === null || abilityIsUnread(id, table)) {
      quiet += 1;
      continue;
    }
    const already = collected.get(id);
    if (already) already.push(value);
    else collected.set(id, [value]);
  }

  const shown: ReadEffect[] = [];
  for (const [id, values] of collected) {
    const shape = abilityShape(id, table);
    shown.push({
      id,
      // Non-null: an id reaches this loop only after `abilityName` named it.
      label: abilityName(id, family)!,
      value: effectValues(id, values, table)
        .map((value) => effectWord(value, shape, { classNames, magnitudeElsewhere }, t))
        .filter((word) => word.length > 0)
        .join(', ')
    });
  }
  return { shown, quiet };
}

/** One value of one effect, in the words its shape calls for. */
function effectWord(
  value: number,
  shape: AbilityShape | undefined,
  context: { classNames: Record<number, string>; magnitudeElsewhere: boolean },
  t: UiLookup
): string {
  // A flag has no magnitude: its label alone is the fact.
  if (shape === 'flag') return '';
  // The number is in the row's own columns, so drawing this zero would
  // contradict it. See `magnitudeElsewhere`.
  if (context.magnitudeElsewhere && value === 0 && abilityIsMagnitude(shape)) return '';
  /*
   * A grant draws its label alone at zero and its number otherwise: the row's
   * presence is the fact, and `Bash +0` would read as a class that is worse at
   * bashing than one with no row at all.
   */
  if (shape === 'grant') return value === 0 ? '' : t('cards.reference.item.effectPlus', { value });
  if (shape === 'percent') return t('cards.reference.item.effectPercent', { value });
  /*
   * Named where the realm's table has the row, and the bare number where it
   * does not — a class id the realm cannot name is still a real restriction,
   * and dropping it would make an item look usable by anyone.
   */
  if (shape === 'class') {
    return context.classNames[value] ?? t('cards.reference.item.effectReference', { value });
  }
  if (shape === 'reference') return t('cards.reference.item.effectReference', { value });
  return value > 0 ? t('cards.reference.item.effectPlus', { value }) : String(value);
}

/**
 * Several values for one id mean two different things, and which one depends
 * on the shape.
 *
 * A **magnitude** stated more than once is the realm disagreeing with itself —
 * a monster name resolving to rows that differ, which the realm file records
 * whole rather than resolving (see `BuiltMob.ab`). Listing `Resist-Fire -100%,
 * -35%` asks the reader to pick, and the reassuring end is the one that gets a
 * character killed, so the **high** end is shown: the same choice `hp` makes,
 * made here because this is where the shape is known and the realm file
 * deliberately does not decide it.
 *
 * A **set** — `ClassOk`, `SpellImmu`, `MonsGuards` — is the realm stating one
 * fact per member, and every member is part of the answer. Reducing those was
 * the bug this function exists to have a name for: `dwarven warrior` states
 * `MonsGuards` three times and a maximum kept one of the three.
 */
export function effectValues(id: number, values: number[], table: AbilityTable): number[] {
  const shape = abilityShape(id, table);
  if (shape === 'class' || shape === 'reference') return values;
  return values.length === 0
    ? values
    : [values.reduce((high, value) => (value > high ? value : high))];
}
