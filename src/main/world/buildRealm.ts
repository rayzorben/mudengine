import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { RealmSource } from './RealmSource';
import { number, text } from './values';
import type { ArchiveIdentity, ShippedWorld } from '../../shared/worlds';
import { itemsInScripts, leversAsked, leversInScript, parseRoomScript } from './roomScript';
import { parseAction } from './instructions';
import { itemKind } from '../../shared/items';
import { HAZARD_ABILITY, MIN_LEVEL_ABILITY } from '../../shared/abilities';
import type { Quest } from '../../shared/quests';
import { blocksInReach, indexQuests, itemsInReach, landingsOfItems } from './indexQuests';
import type { BuiltItemFrom, ItemLanding } from './indexQuests';
import { indexSpellHazards } from './spellHazard';
import type { MobAttack, MobCast, MobProfile, RequirementAction } from '../../shared/world';
import { familyOfBuild, isEmptyBuild, type RealmBuild, type RealmFamily } from '../../shared/realm';
import {
  alignmentCost,
  costsAlignment,
  DISPOSITION_CODE,
  dispositionOf,
  worstDisposition,
  type MobDisposition
} from '../../shared/mobs';

/**
 * Turning a realm database into the one normalised form the client loads.
 *
 * **Normalisation happens here, once, and never at runtime per line.**
 * docs/legacy-assessment.md §5 consequence 4: the CoffeeScript engine issued
 * synchronous SQLite queries from inside block parsing, on the main thread, per
 * line of server output. This function is what makes that impossible — the
 * whole realm is read, indexed and written out in one pass, and nothing
 * downstream has a database handle to misuse.
 *
 * Shared by the build script and by the runtime path that converts a realm file
 * a player has chosen. One implementation, so a client-converted realm and a
 * shipped one cannot disagree about what a room is.
 */

/**
 * The realm file format.
 *
 * Bumped whenever the header gains something a consumer would otherwise have to
 * guess at. It is folded into the cache key a converted realm is stored under
 * (`RealmLibrary`), because the alternative is a client that keeps reading a
 * conversion made by an older build and silently lacks whatever the bump added
 * — which for v5 is *whether a monster attacks on sight*, a question auto-combat
 * answers `no` to when nothing says otherwise.
 *
 * | v | What it added |
 * |---|---|
 * | 3 | The monster index, by name |
 * | 4 | Shops and their stock |
 * | 5 | Monster disposition — `Align` and `Type`, per `shared/mobs.ts` |
 * | 6 | Item kind, slot, and a weapon's or armour's own numbers, per `shared/items.ts` |
 * | 7 | What kind of shop a shop is — bank, temple, inn — from `Shops.ShopType` |
 * | 8 | Stockless places kept for their kind — a bank sells nothing and is still a bank |
 * | 9 | A lair names its monsters by number, and an exit's level gate |
 * | 10 | The race and class indexes — the two words on every `look` at a player |
 * | 11 | Every item name, so a thing on the floor is recognised as one |
 * | 12 | What a monster is worth and what it takes — `EXP`, `ArmourClass`, `DamageResist`, `MagicRes`, `HPRegen`, `Follow%`, `Undead`, its coin drop and its drop table — and an item's `Abil-n` effects |
 * | 13 | The words a room answers: `Rooms.CMD` through `TBInfo.Action`, and the spell a room casts on whoever stands in it |
 * | 14 | `Abil-n` effects on the other four tables — monsters, spells, races and classes. Only the item half was ever written out, so a spell card said its level and mana and never what casting it does, and a monster's fire resistance was in the realm and on no screen |
 * | 15 | Who may use an item — `Items.ClassRest-n`, `RaceRest-n` and the `MinLevel` gate. Columns of the realm's own, read by nothing until now, so the pack offered a `wear` button for an item the realm already said this class could not have, and the server answered `You may not wear that item!` |
 * | 16 | A spell's own magnitude — `MinBase`, `MaxBase`, `Cap` and the three per-level growth pairs. The `Abil-n` row names *what* a spell affects and 1,410 spells put *how much* in these columns instead, so a card drew `M.R. 0` off a genuine zero while the 10 sat in a column nothing wrote out |
 * | 17 | `Spells.Targets` — who a spell may be cast on. Without it a heal picker had to offer all 1,990 rows, so `way of the swan` (self only) and `minor healing` (self or another) were indistinguishable, and configuring the party heal with a self-only spell produced a refusal once a round |
 * | 18 | What an entity needs that the file did not carry: `Items.Gettable`, `Not Droppable` and `Limit`; `Monsters.Type` (undecoded), `AvgDmg`, `CharmLVL`, `MidSpell-0..4` and `DeathSpell`. `Rooms.NPC` had been *written* since the file began and read by nothing — the read side arrives here |
 * | 19 | No new column: `ExpTable` on a race and a class is written when it is **non-zero** rather than when it is positive. Stock MajorMUD prices a Thief at `-20`, and it is a term of `100 + race + class` — the multiplier the whole experience table is built from — so dropping the sign charged one a fifth more per level than the realm does. The number is bumped for the *cache*: `RealmLibrary.identity` keys a converted realm on the format, the path, the size and the mtime, and none of the last three moves when the converter changes, so a player who had already converted their own database would have kept the bug this fixes, silently |
 * | 20 | How a monster fights, **per row**: the five `Att…` slot groups (type, effective chance, accuracy or spell, damage or cast odds and level, energy, hit spell) and the five `MidSpell…` groups with their marginal per-round chance and cast level — `BuiltMob.pf` — and `Spells.TypeOfResists`. Auto-combat had every monster's `AvgDmg` and nothing about *how* it was dealt, so it could not weigh a paralysing caster against a biter, and took the room in the order the server listed it |
 * | 22 | `Spells.Diff` — how much easier or harder a spell is than the caster's own spellcasting figure, signed and ranging −200 to 200 across both databases on this machine. `indexSpells` read twelve columns and never that one, so the client held every input to the server's cast-success roll except the one that varies per spell, and a caster could not be told which of two spells would actually land |
 * | 23 | **The levers.** A room's ten direction columns hold what it *does* as well as where it leads, in two shapes surveyed out of both databases (`Action#1 [on the S exit of this room]: pull lever, move lever` and `Action [on the N exit of room 1/1331]: …`) — 299 cells in each, and `parseExit` returns null for every one, so the converter had dropped the lot since it was written. Both ends are joined here: the room holding a lever gains it as a word it answers (`RoomCommand.opens`), and an exit stating `Hidden/Needs N Actions` gains the phrases (`Requirement.actions`) where the count matches and every lever is in the room the exit leaves. Without it the realm said *there is a concealed passage south and the lever is in this room*, the client walked into it, was refused, and struck a real corridor out of every route for the session — todo 01 |
 * | 21 | The database's own account of itself — the `Info` table, whole (`build`), and the formula family read off it (`family`). A table `buildRealm.ts` had never opened, so the client could not say which of the two lineages' arithmetic a realm runs, nor which build of which data set any derived number came from |
 * | 24 | **The quests.** No realm database has a Quests table, and both on this machine hold the same ten without one — but `TBInfo` holds 4,355 scripts, and between their gates and their rewards they state every quest completely. `indexQuests.ts` finds the counters by which abilities are both granted and demanded, walks the blocks forward from every monster's greeting and every room's script, and comes out with who to ask, where they stand, the word to say, what it costs and what it pays. The client had 1,914 monsters and no way to tell which of them wanted anything |
 * | 25 | `Items.UseCount` keeps the realm's **`-1`** instead of dropping it. Absent had meant both *the realm says nothing* and *the realm says for ever*, which are opposite answers to the one question that decides whether invoking an item costs anything — and 39 items in the shipped realm, nine of them weapons casting a bless, read as unstated. See `AutoInvoke` |
 * | 29 | **Where a scripted spell lands.** A room command's `cast <spell>` step was narration to the parser, so a phrase whose only movement is a spell carrying `TeleportRoom`/`TeleportMap` had no `to`: the three holes down from Dragon's Teeth Hills into the Stone Tunnel are `cast 336` (*fall*), and the router had the climb back up (`teleport 487 2`) and not the drop — ten rooms in Paradigm, eight in stock — which is why a route from Silvermere to the Black Mountains went round through the Black House and map 7. `parseRoomScript` takes the spell table's landings and `linkPortals` walks them like any other |
 * | 28 | **The item a lever needs.** `lift up talisman (Item: 815)` ended 172 of Paradigm's lever cells and 170 of stock's, and `parseAction` split it into the phrases like any other — so the router priced a passage the server refuses without the talisman at the cost of a free lever, and the walker said the words to a wall. `RequirementAction.item` carries the number; the router walls the exit for a pack that lacks it and names the item in the refusal; the item is indexed like a key so the name is there to say — todo 13 |
 * | 27 | **Which bundled world this is, and the archive it came from.** `world` names one of the two the client ships and `archive` is that file's name, size and SHA-1, so a database a player names can be recognised as the very bytes a bundled world was built from and loaded as that world rather than converted into a second copy keyed under a second name. And `Custom: Default` — the stock v1.11p data set's own name for itself, read off `mdb/majormud-v1.11p.zip` — reads as the MajorMUD family; it read as no family at all, so every calculator declined on the one world that ships for MajorMUD realms. Bumped for the cache, like 19 and 26 |
 * | 26 | **A quest step's alternatives, kept apart.** A text block holds one line per class — fifteen on the alignment chains — and each line is a complete route with its own gate, its own price and its own reward. `stepsInBlock` merged lines advancing the same counter to the same rank by *unioning* them, so a step said **be a Warrior and a Witchunter**, be level 22 and level 20 at once, and take all fifteen classes' perks: a wrong answer rather than a long one, on 23 of the 251 steps and every one of the three great chains. What every route shares stays on the step; the rest is `QuestStep.ways` (`shareRoutes`). Bumped for the **cache**, like format 19: a player who had already converted their own database would otherwise keep the union for ever, since none of the path, size or mtime `RealmLibrary.identity` also keys on moves when the converter changes |
 * | 30 | **What a room's own spell does, and what stops it.** `Rooms.Spell` has been written out since format 13 and read by nothing, so the router priced the whole Silver River — 845 rooms whose spell bashes anybody without a boat against the rocks — at one step a room, and a route from the Pier to the Gnoll Encampment went eighty-eight of them rather than a hundred and four through the slums. The harm is one step down a chain the runtime cannot walk: `river damage` carries no magnitude at all, only `TextBlock 2750`, which reads `failitem 690:failitem 691:failitem 1181:failitem 3609:message 2096:cast 754` — a log raft, a wooden skiff, a silverbark canoe or a river punt stops it, and otherwise `battered` takes 10–20. `TBInfo` is not converted, so `indexSpellHazards` follows the chain here and writes the answer onto the spell (`BuiltSpell.hz`); the router prices the room by it and un-prices it for a pack holding one of the items — todo 01 |
 * | 31 | **A lair's monsters are its own rows, and a room's spell can summon.** A lair names its monsters by row number and the index folded every row sharing a name into one record, so `Hillside Path, Guard Post` — row 224, a 100-HP gnoll scout that lands one blow in twenty-five — was weighed as row 2204, an 830-HP gnoll scout that swings four times a round, and a level-12 Paladin was told the room was expected to kill it. `BuiltMob.pr` and `pd` carry each row's own profile and disposition beside its number, so `WorldGraph.lairEntities` weighs the row the lair actually spawns; a name off the wire still folds, because the wire carries no number. And `spellHazard.ts` reads a roll table (`77:addexp 0`, `81:message 2645`) as the dice it is rather than as an unknown verb, and `summon` as a fact (`BuiltSpellHazard.sm`) rather than as a chain it cannot follow: 71 of Paradigm's 159 room spells were unread, and 29 rooms of the Silvermere's own weather were priced as a hazard — todo 01 |
 * | 32 | **A row's own numbers, so a name standing in a room can be resolved to one of them.** Format 31 gave a lair the row it spawns; the wire still carried only a name, so the Reference card answered *gnoll scout* with the fold of rows 224 and 2204 — `100–830 hp`, 75 AC, and a fight it priced at 2,161 hp of chewing. But a room is a very strong clue to which row is standing in it: the Gnoll Tent's own lair names 224, and the nearest room row 2204 spawns in is on another map. `BuiltMob.rw` carries every row's own health, defence, worth, regeneration, pursuit and average blow beside its number — subsuming `pr` and `pd`, which were the same per-row shape written as two parallel arrays — and `WorldGraph.resolveMobRow` picks the row by the room, saying which and how. Written only where a name holds several rows, because with one row the fold *is* the row — todo 02 |
 * | 33 | **The realm's own clocks: a lair's respawn and a placed monster's.** `Rooms.Delay` was in every room row and read by nothing, so the client could price what a lair *costs* and never what it *pays*, and it sat a character down in a room that makes monsters every twenty seconds (todos 05 and 08). `BuiltRoom.dl` carries the column as the realm states it — minutes, except an Arena room and a negative figure are seconds (`Room.GetDelayInSeconds`), and GreaterMUD's regen adds thirty seconds to the elapsed time before comparing (`RegenSlot.cs:33`), so the reading lives in `src/shared/hunting.ts` behind the family. `BuiltMobRow.rt` is `Monsters.RegenTime` in hours, the clock a *placed* monster comes back on (`MobType.Regen * 3600`) — a boss's, never a lair's — todo 05 |
 * | 34 | **A spell's element.** `Spells.AttType` was in every spell row and read by nothing, so a lightning bolt could not be told from a fireball when the monster in front of the character resisted lightning; `BuiltSpell.at` carries the column as the realm states it and `WorldSpell.element` is `Spell.GetSpellAttackType`'s reading (0 cold, 1 hot, 2 stone, 3 lightning, 4 normal, 5 water, 6 poison), so `chooseAttackSpell` can take the monster's `Rlit` off the damage the way `Spell.CheckResistance` does — todo 09 |
 * | 35 | **Who a trainer takes, and what it charges.** `Shops.MinLVL`, `MaxLVL` and `ClassRest` were in every shop row and read by nothing, so a client that wanted to go and collect a level had no way to pick a room: the Ninja Training Room trains 1–10 and a level 30 Ninja walking to the obvious place is told *You have progressed too far*. 46 trainers in Paradigm, in bands that overlap heavily (21–50, 31–52, 41–54, 51–75), one class id per row where the row is restricted and 0 where it is not. And `markup` was written only where positive, which is right for a price and wrong for a *choice*: `Titan Trainer` (21–50) charges 6,000% and `Sixty Seven` (1–67) 1,200% for the same level, so the column decides which room to walk to — todo 18 |
 * | 36 | **A monster's own clock survives a name that holds one row.** `BuiltMobRow.rt` (format 33) was the one per-row column with no counterpart on the fold, and `rw` is written only where a name holds several rows — so for a *uniquely named* monster, which is what a boss is, `Monsters.RegenTime` reached nothing: 305 of Paradigm's 381 stated clocks and 228 of stock's 311 were dropped on the floor, `WorldMob.regenHours` was declared and set by nobody, and todo 09's cycle weighting was inert for exactly the case it was written for. The Hunting card offered a two-room Graveyard loop at 128,862 exp/h because a 1,500-point Gravedigger on an hour's regeneration was averaged in whole, one of four equally likely rows coming back every thirty seconds. `BuiltMob.rt` is written only where every row of the name agrees, a row stating none voting `0`, so a clock is never invented for a lair row whose twin is a boss — todo 15 |
 * | 37 | **A quest step you kill for.** `traverse` rooted only at `Monsters.GreetTXT` and `Rooms.CMD`, so a block reached by neither was built owning nothing: no place to go, nobody to ask, no word to say — a rank and a reward floating on the track. 37 of Paradigm's 218 quest-step blocks and 13 of stock's 95 were in that state, and **32 and 12 of them are a monster's death**. `Monsters.DeathSpell` is cast on the corpse and chains one link — the dread mystic's `dread mystic temp` ends (`EndCast`) in `dread mystic text`, whose `TextBlock` is 1417: *be at Phoenix rank 1, take the yellowed note, go to rank 2*. They are the chains' bosses, which is the whole point of them: reported as *the flag is given in a death message from dread mystic and that isn't shown anywhere*. `QuestStep.kill` carries the monster, the room is its `Summoned By`, and the death root is queued **after** the other two so a block the smuggler boss also greets you with stays a conversation |
 * | 38 | **A lever the room's own script pulls, and the one behind a conversation.** A lever reaches the realm two ways and the converter read one: format 23 took the direction columns (`Action [on the N exit of room 1/1331]: pull lever`) and every `remoteaction` step in a text block was dropped as an unknown verb. `TextBlockPart` reads it as `remoteaction <room> <message> <ordinal> <exit>` — the room on the map the player is standing on, the exit by the server's own numbering, a `Door` opened outright and a `HiddenExit` performing its ordinal's action. 101 steps over 30 exits in Paradigm and 82 over 25 in stock, and **one** of those exits had a lever already: 68 of Paradigm's steps open an exit reading `Hidden/Needs N Actions` that states no action at all, and 27 open a door priced at 251 to 1,000 picklocks, which is a wall to everybody. The portcullis in 8/909 is lifted by saying `lift portcullis`, and the client had the words on the Room card with nothing joining them to the west exit they raise. Five more sit behind a monster's `GreetTXT` — the shadow guard who opens the door to Morukai, four stone sphinxes — where the phrase is `ask <monster> <word>` and **a reached block's lines are steps rather than `phrase:steps`**, which is what three of the four sphinxes turn on. `RoomCommand.opens` and `RemoteLever` gained the item the realm says must be carried (92 of Paradigm's 314 levers, 91 of stock's 296), because a door's own requirement is not where its lever is written and `use crowbar` is not a free lever |
 * | 39 | **Where a script hands an item over.** `neededItems` was fed by exits, levers, shops, monster drop lists and **room-owned** scripts, so an item the realm hands over in a text block no room owns had no row at all: `acid gland`, `unfertilized eggs` and `double-terminated quartz` are `giveitem` in three blocks run by a monster's **death** (a white jelly's, a queen ant's, Leo the Quick's), and the Reference card answered *Named in the world data, with no further detail* about three of the four things the Phoenix quest sends a player to fetch — reported as *these are real sundry items and are dropped through the textblocks of monsters or rooms*. `itemsInReach` reads the quest traversal — every block a greeting, a room's script or a death spell can run — for items rather than for counters. That closes the naming half (1,226 → 1,296 rows in stock, 1,942 → 2,056 in Paradigm; items with no source at all fall from 109 to 33 and from 128 to 23) and answers the other one: `BuiltItem.from` carries the owner's kind, its name, the `map/room` the realm places it in and the words that reach the line, so an item is a monster to look up and a room to walk to. 221 of stock's items carry one and 389 of Paradigm's |
 * | 40 | **An item can be a door, and a block whose line is one step places nothing.** Two halves of one report — *it is showing the titanium fork but it is not showing the potion of levitation*, and *when I click the fork there is no way to figure out how to get it*. The first: the only entrance the Catacombs have is the **potion of levitation**, which the corridor table says nothing about at all — the realm states it as `Items.Abil-n = CastsSp 607`, that spell's `TextBlock 1421`, and `teleport 1009 9` inside it, so an item is a *way in* exactly as a key on a door is. `landingsOfItems` follows the three hops at build time (the middle one is `TBInfo`, which does not ship) into `BuiltItem.lands`, and `WorldGraph.approachItems` treats a landing inside an enclosed region as a way into it: 4 items in Paradigm and 4 in stock. The second: `itemsGivenInLine` read a line as `phrase:steps` and dropped the first field, which is true of a **room**'s script and of nothing else — so a block whose whole action is `giveitem 983` placed nothing, and the fork the Catacombs are locked behind came from nobody. 26 items in Paradigm and 15 in stock get their only source back, the gnome inventor's fork among them |
 * | 41 | **And where that item may be used, because a teleport is not an *anywhere*.** Format 40 read the `teleport` step out of an item's text block and dropped every other step in it, so a conditional effect was recorded as an unconditional one — the client planned `use potion of levitation` in the Alchemist's Hut, the server answered with nothing at all, and the walk stopped on its own eight-second timeout. `TBInfo 1421` is `roomitem 993 1834:message 1835:teleport 1009 9:message 1836`, and `roomitem` is a **guard**: `TextBlockPart.cs` returns `Failed` when the room lacks the item, its own comment on the branch reading *used for potion of levitation for example*, so the block stops on step one and the teleport never runs. Item 993 is `waterfall`, which `Items."Obtained From"` places in `Room 3/1` — the pool under the waterfall, reached by boat up the Silvermere from the Pier (`BOATMOST.mp` wants a `wooden skiff`), and the one room MegaMUD's own 4,501 path files ever use the potion in. `BuiltItem.landsFrom` carries those rooms and `linkPortals` makes the landing an ordinary portal out of each of them, so the router walks to the waterfall and uses it there. Paradigm's seven recall tokens carry `nomonsters 3509` and `failroomitem 3391` instead — conditions on the moment and not on the place — and stay usable anywhere, which is why no path file paths one. A `roomitem` whose item the realm places nowhere **withholds the landing**, rather than claiming it works everywhere |
 * | 42 | **What a room holds by the realm's own hand.** `Rooms.Placed` was written as the raw string since the file began and read by nothing, so the client could not say where a thing lies nor what a room is furnished with. The server puts each placed item on the room's floor at start and **puts it back at every nightly cleanup** where it is missing, within its game limit (`RoomManager.LoadPlacedItems`, `DoCleanup`), and it is listed like any other item — `You notice log raft here.` on the wire. `BuiltRoom.pl` carries the ids and each one is named: 554 rooms and 268 items in Paradigm (200 of them newly named), 362 and 193 in stock; 211 and 140 of them the realm will not let anybody pick up — signs, coffins, trees, portals. `WorldGraph` indexes the other direction at load, so the fact is written once |
 * | 43 | **The spell a room's own command puts on you, and a gate is followed rather than called unread.** `dive pool` at the Bountiful Oasis (`Rooms.CMD` 2500) is `message 1943:teleport 121 12:cast 512`, and `roomScript.ts` read the landing (format 29) and dropped the cast as narration — so *holding breath* (25 ticks, `EndCast` into *drowning* at 5–20 a tick, into *drowned to death*) was written nowhere, and the eleven Muddy Underwater Passage rooms between the pool and the way up were a free corridor to the router and to a quest's plan. `RoomCommand.casts` carries the spell and `WorldGraph.corridorsAlong` reads its chain at the plan. And `spellHazard.ts` follows a gate on the character — `checkitem`, `checkspell`, `checkability`, `minlevel`, `maxlevel`, `class`, `race`, the alignment pair — at full weight instead of calling the chain unread: `TextBlockPart.cs` answers each from the sheet with `Succeeded` or `Failed`, so what stands behind one happens to *some* character and the pessimistic reading is to follow it. The desert's spell (683) is 85% nothing, a sandstorm teleport for level ≤ 19 and a one-in-a-hundred summons, all of it behind `failspell 711` — the waterskin — and the gates open its chain (it stays *unread* for a one-tick spell whose `EndCast` is the sandstorm, which is the `EndCast` rule doing its job); the oasis pools' *stop drowning* (515) is `checkspell 512 4099:cast 515`, which removes the spell and hurts nobody, and read as a hazard on eight rooms of every route to the Golden Spire. The block a spell gate names is run for a character without the spell, so it is followed too |
 * | 44 | **The quest indexer keeps the roll and the delay** (todo 106). `testskill <stat> <value>` is a roll — the stat less the value, clamped 2..98, against 1–100 (`TextBlockPart.cs:1139`) — and `adddelay N` holds the rest of the block N seconds (`ContinueTextblockCommand`); `roomScript.ts` dropped both. `readQuestScript` keeps the roll as a `skill` gate and the delay on the line, `stepsInBlock` carries the longest onto `QuestStep.delaySeconds`, and the runner reads them: a step that rolls is asked again, after its delay, a bounded number of times. The red book at 12/2248 is the one case in the Dao Lord chain |
 * | 45 | **`checkspell` is what the waterskin does to the desert, on the data that spells it that way.** Format 43 followed a `checkspell <spell> <block>` gate and deliberately declined to read it as *this spell stops the room*, on the ground that the two GreaterMUD builds answer the verb opposite ways. `TextBlockPart.cs:479` returns `Failed` unconditionally and runs the block only for a character the spell is **not** on, and `ExecuteOnMatch` breaks the line on `Failed`, so the block is the whole of what the room does and it is `failspell`'s shape exactly. Live, Festus took *You suffer in the desert heat…* 24 times, typed `drink water` — spell 711 — and crossed 26 more desert rooms without it printing once. The two shipped worlds spell the desert's own gate differently: Paradigm and GreaterMUD write `failspell 711 2654` and already named the ward, MajorMUD's v1.11p data writes `checkspell 711 2654` and named none — so stock goes from **0 warded room spells to 3** (946 rooms, 945 of them desert) and Paradigm from 2 to 4 (+57 rooms). No hazard loses a figure, since the block was already followed. Bumped for the **cache**, like 19, 26 and 27 — todo 02 |
 * | 46 | **A gate on level says *which* character, and the router is planning for one.** Format 43 follows `minlevel` / `maxlevel` at full weight — what stands behind a gate happens to *somebody* — and then flattened it, so the desert's sandstorm (`86:maxlevel 19:cast 713`, a one-in-a-hundred teleport) was priced as *it moves you somewhere else* on all 979 of Paradigm's desert rooms, for a level 21 character it cannot touch. Reported as *it is set to maxlevel 19 so in this case festus is level 21 so it wont execute and can be ignored*. `BuiltSpellHazard.lv` carries the band each of `d`, `tp` and `sm` was recorded under — a gate governs the rest of its own line, so the band is taken back at the end of each — and `hazardFor` (`src/shared/world.ts`) narrows a hazard to the character's level at `WorldGraph.hazardOf`, the one join. **An unstated level keeps the whole hazard**, and an effect recorded both inside a gate and outside one is ungated: the reassuring answer here is *it cannot happen to you* — todo 01 |
 * | 47 | **The coin a price is counted in.** `Items.Currency` was never read, so the realm's `Price` was a number in no unit and a counter's charge could not be known before `list` was spent on it: a quest run walked to the General Store for two waterskins, was quoted 50 silver nobles each against an empty purse, and stood there with 8.6 million copper in the Bank of Godfrey. `BuiltItem.cur` carries the code (0 copper … 4 runic, `BuyCommand.GetCopperValue`) where it is not copper, and `WorldGraph.priceAt` multiplies it through the shop's markup exactly as the server does, so the supplies errand knows what to withdraw before it walks — todo 00 |
 */
export const REALM_FORMAT = 47;

/**
 * What `build-world.mjs` says about a world it is bundling: which of the two
 * it is, and the archive it read. The runtime conversion path passes nothing —
 * a player's realm is named after its file and recognised by nothing else.
 */
export interface ShippedBuild {
  world: ShippedWorld;
  archive: ArchiveIdentity;
}

/**
 * A file's identity by content: its name, its size and the SHA-1 of its bytes.
 *
 * Read by the build script for the archive it bundles, and by `RealmLibrary`
 * for a database a player names, so the two can be compared. The size is
 * cheap and is checked first; the hash is what settles it.
 */
export function identityOfArchive(file: string): ArchiveIdentity {
  const bytes = fs.readFileSync(file);
  return {
    name: path.basename(file),
    size: bytes.length,
    sha1: crypto.createHash('sha1').update(bytes).digest('hex')
  };
}

/** The ten directions, in the column order every export of this table uses. */
export const DIRECTIONS = ['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW', 'U', 'D'] as const;

export interface BuiltRealm {
  /** The gzipped JSON-lines body, ready to write. */
  lines: string[];
  header: {
    v: number;
    source: string;
    rooms: number;
    generatedAt: string;
    items: BuiltItem[];
    mobs: BuiltMob[];
    shops: BuiltShop[];
    spells: BuiltSpell[];
    races: BuiltRace[];
    classes: BuiltClass[];
    /**
     * The database's own account of itself — format 21, the `Info` row whole.
     *
     * Absent when the file has no `Info` table or its row is empty, which is
     * the honest answer for a derivative that dropped it: a realm that cannot
     * say what build it is does not get given one.
     */
    build?: RealmBuild;
    /**
     * Which lineage's arithmetic this data set belongs to, read from `build`.
     *
     * Written out rather than re-derived on load so that the *conversion* is
     * where the reading happens — one place, versioned by `REALM_FORMAT`, so a
     * change to how the family is read reconverts every player's realm instead
     * of quietly disagreeing with the file already on their disk. Absent when
     * the database does not say, which is never a fallback to the other family.
     */
    family?: RealmFamily;
    /**
     * Which of the two bundled worlds this is, and the archive it was built
     * from — format 27, written only by `build-world.mjs`. A realm a player
     * converts carries neither: it is theirs, named after its file.
     */
    world?: ShippedWorld;
    archive?: ArchiveIdentity;
    /**
     * Every item name the realm has, for recognising one in a line of text.
     *
     * Deliberately separate from `items`, which is the *detail* index and is
     * kept narrow on purpose — about a hundred keys some exit references, plus
     * what the shops stock. That narrowness is right for "what is this worth,
     * what does it weigh"; it is wrong for "is this a thing", and the two were
     * the same list. `You notice large sign, small sign here.` — the realm's
     * own furniture, sold by nobody and needed by no exit — was therefore not
     * recognised as items at all, so the two things named in a room the
     * character was standing in were the two words on the line that could not
     * be clicked. Names alone: 2,559 of them is 41KB, where the whole detail
     * table would be an order of magnitude more for facts nothing asked for.
     */
    itemNames: string[];
    /**
     * The realm's quests, assembled from its text blocks. See `indexQuests.ts`.
     *
     * Empty for a realm with no `TBInfo` table, and for one whose blocks chain
     * no ability — which is the honest answer for a derivative that scripts
     * nothing, rather than a promise of a book with nothing in it.
     */
    quests: Quest[];
  };
  /** Counts worth reporting, and worth refusing an empty realm on. */
  stats: {
    rooms: number;
    withExits: number;
    withInstructions: number;
    /** Rooms that answer a typed word, from `Rooms.CMD`. */
    scripted: number;
    /** Rooms holding a lever — a direction column that is not an exit. */
    levered: number;
    /**
     * Levers dropped because several of the room's own commands answer to the
     * phrase, so which one opens the exit is not a thing the data says.
     */
    ambiguousLevers: number;
    /** Action-gated exits whose every lever is pulled in the room they leave. */
    openableHere: number;
    items: number;
    mobs: number;
    shops: number;
    spells: number;
    races: number;
    classes: number;
    itemNames: number;
    quests: number;
    questSteps: number;
  };
}

export interface BuiltItem {
  id: number;
  n: string;
  shops?: string[];
  mobs?: string[];
  /**
   * Where a script hands one over — format 39. See `itemsInReach`.
   *
   * The third answer to *where does this come from*, beside the shop that
   * stocks it and the monster whose `DropItem-n` names it, and the only one
   * that is not a column: a realm hands its quest components over in a text
   * block, run by a word said to an NPC, a word said in a room, or a monster's
   * death. Absent for the great majority; written for 46 of the stock realm's
   * items and 47 of Paradigm's.
   */
  from?: BuiltItemFrom[];
  /**
   * Where **using one** puts the character, as `map/room` — format 40.
   *
   * Not a column: `Items.Abil-n = CastsSp <spell>`, that spell's `TextBlock`,
   * and a `teleport <room> <map>` step inside it. Derived at build time
   * because the middle hop is `TBInfo`, which does not ship
   * (`landingsOfItems`). Written for the handful of items that are doors —
   * the potion of levitation is the only entrance the Catacombs have, and the
   * exit table says nothing about it.
   */
  lands?: string;
  /**
   * The rooms using it works in, as `map/room` — format 41.
   *
   * Absent where the chain carries no `roomitem` guard, which means *wherever
   * you stand* (the recall tokens). Never empty: a guard the realm places
   * nowhere drops `lands` with it, because a way this converter cannot
   * describe is not one to offer. See `landingsOfItems`.
   */
  landsFrom?: string[];
  /**
   * What the realm charges for one, before a shop's markup.
   *
   * Carried because the client can then answer "what is this worth" without
   * spending a command on `appraise` — the standing rule of the world layer:
   * asking the server for something the shipped data already knows is a command
   * spent for nothing (docs/greatermud/rooms-and-items.md).
   */
  price?: number;
  /**
   * `Items.Currency`, the coin `price` is counted in (format 47): 1 silver,
   * 2 gold, 3 platinum, 4 runic. Written only where not copper, so absent on a
   * file of format 47 or later is copper, and on an older one is unknown.
   */
  cur?: number;
  /** What it weighs, in the units the status line's encumbrance is counted in. */
  enc?: number;
  /**
   * `ItemType`, kept as the realm's number rather than a word.
   *
   * The word is `shared/items.ts`'s reading of the number and may be
   * corrected; the number is what the realm said. Absent when the column is
   * missing, never defaulted — a derivative without it names no kinds.
   */
  type?: number;
  /** `Worn`, the realm's number. Absent when zero. */
  worn?: number;
  /** A weapon's `Min`, `Max`, `Speed`, `StrReq`, `Accy`, `WeaponType`. Only when `type` is a weapon's. */
  wpn?: { min: number; max: number; spd?: number; str?: number; acc?: number; kind?: number };
  /** Armour's `ArmourClass`, `DamageResist`, `ArmourType`. Only when `type` is armour's. */
  arm?: { ac?: number; dr?: number; kind?: number };
  /**
   * `UseCount`: how many times the item may be used, and **`-1` for
   * unlimited**, which is written out rather than dropped — format 25.
   *
   * It used to be dropped, on the reasoning that a card showing `-1 uses` is
   * nonsense. That is true of the *display* and it cost the fact: absent then
   * meant both *the realm says nothing* and *the realm says for ever*, which
   * are opposite answers to the one question that decides whether invoking an
   * item is free. Thirty-nine items in the shipped realm are unlimited-use
   * spell casters — nine of them weapons that cast a sixty-tick bless — and
   * every one of them read as *unstated*.
   *
   * `0` is still left out: it is the realm's empty cell, not a count.
   */
  uses?: number;
  /**
   * `Abil-n` / `AbilVal-n`, the realm's effect system — format 12.
   *
   * `[id, value]` pairs in the realm's own numbering, decoded by
   * `src/shared/abilities.ts` at the point of display rather than here: the
   * numbering is stable and the *reading* of it is a claim from another
   * client's source that may be corrected, so what is written to disk is the
   * realm's own answer and never an interpretation of it.
   *
   * Only pairs the ability table can name are kept — `abilityIsNotable` is
   * deliberately **not** the filter, because that is a display judgement and
   * this is the file every future card reads. Empty slots (`Abil-n = 0`) are
   * dropped: an item with `Abil-3 = 0` has three effects, not four.
   */
  ab?: Array<[number, number]>;
  /**
   * `ClassRest-0..9` and `RaceRest-0..9` — who may use it. Format 15.
   *
   * Their own columns, and nothing to do with the `Abil-n` pairs: `ClassOk`
   * (ability 59) is a separate question the realm answers separately, and the
   * two disagree wherever both are stated. Row ids in `Classes` and `Races`,
   * kept as the realm's numbers for the reason `ab` is — the *reading* is the
   * client's and the number is the realm's. Zero is the empty slot.
   */
  cls?: number[];
  race?: number[];
  /** `MinLevel` (ability 135), lifted out of `ab` because it gates rather than describes. */
  lvl?: number;
  /**
   * `Items.Gettable` — **0 when the realm refuses to let it be picked up**.
   * Format 18.
   *
   * Written only for the refusal, because that is the fact worth carrying:
   * 2,594 of the shipped realm's 2,639 items are gettable, so writing the
   * ordinary answer would be a byte per item to say nothing. Absent is
   * gettable, which is also the right answer for a derivative realm without
   * the column — refusing to loot on an absent column would be the client's
   * ignorance stopping an automation that works.
   */
  ngt?: 1;
  /** `Items.Not Droppable`, written only when true. Format 18. */
  ndr?: 1;
  /** `Items.Limit` — how many may exist at once. Format 18. */
  lim?: number;
}

/**
 * A shop, and what the realm says it stocks.
 *
 * A shop is a property of a *room* — `Rooms.Shop` holds the number — so this is
 * what turns "you are standing in a shop" into "you are standing in a General
 * Store that sells a torch, a lantern and a crowbar". Which is the whole point:
 * the alternative is typing `list`, and a command is the scarce resource.
 *
 * **Stock is item ids, not names.** A name here would be a second copy of a
 * string the item index already holds, 1,386 times over, and two copies of a
 * name are two things that can disagree.
 */
export interface BuiltShop {
  id: number;
  n: string;
  /** Item numbers, in the order the realm lists them. */
  items: number[];
  /** Percentage the shop adds to the base price, when it states one. */
  markup?: number;
  /** `MinLVL` — the lowest level this place serves. Format 35. */
  min?: number;
  /** `MaxLVL` — the first level it no longer serves. Format 35. */
  max?: number;
  /** `ClassRest` — the one class id it is restricted to; absent means anybody. Format 35. */
  cls?: number;
  /**
   * `ShopType`, the realm's number. Sampled: 5 temple, 6 tavern, 7 bank, 8
   * training room, 9 inn, 10 an ordinary shop; the rest are placeholders,
   * gang and deed shops. The legacy client's `shopTypes.coffee` names the
   * same numbers. Kept as the number; `WorldGraph` turns it into a word.
   */
  t?: number;
}

/**
 * A spell the realm knows.
 *
 * The reference a MegaMUD-era player kept on paper: what it costs, what it
 * needs, how long it lasts. Every row with a name is kept rather than a subset,
 * because unlike an exit's key there is no way to know in advance which spell
 * somebody will want to look up.
 */
export interface BuiltSpell {
  id: number;
  n: string;
  /** The abbreviation the realm accepts in place of the name. */
  short?: string;
  /** Level required to cast it. */
  level?: number;
  mana?: number;
  energy?: number;
  /** Duration, in the realm's own units. */
  dur?: number;
  /**
   * `Spells.Diff` — format 22. Signed; see the write side for why.
   *
   * Short, like every key here, because this file is 55,806 lines of JSON and
   * a full word per spell is a megabyte for nothing.
   */
  dif?: number;
  /** `Spells.AttType`, as stated — the element (format 34). */
  at?: number;
  /**
   * `Abil-n` / `AbilVal-n` — format 14, and the same pairs an item carries.
   *
   * Written verbatim, decoded by `src/shared/abilities.ts` at the point of
   * display. See `abilityPairs`.
   */
  ab?: Array<[number, number]>;
  /**
   * `MinBase`–`MaxBase` — how much the spell does before level scales it, and
   * the columns a spell's numbers actually live in. Format 16.
   *
   * Written because the `Abil-n` row names *what* a spell affects and often
   * says nothing about how much: `way of the owl` is `M.R.` with `AbilVal 0`
   * and a power of 10, and the card read `M.R. 0` off the column the realm
   * genuinely holds a zero in. 1,410 of 1,990 spells state a power.
   */
  pw?: [number, number];
  /** `Cap` — the ceiling the scaling reaches. 508 spells. */
  cap?: number;
  /**
   * `Spells.Targets` — who the realm lets this spell be cast on. Format 17.
   *
   * The realm's own number, written verbatim and read by
   * `spellTargeting` in `src/shared/spellcraft.ts`, for the reason
   * `ab` is written verbatim: the *reading* of an enum this database
   * writes down nowhere is a claim that may be corrected, and a
   * correction must not require every realm to be converted again.
   * Omitted for `0`, which is the realm's own empty answer.
   */
  tg?: number;
  /** `[MinIncLVLs, MinInc]`, and the `Max` and `Dur` pairs beside it. */
  mig?: [number, number];
  mag?: [number, number];
  dug?: [number, number];
  /**
   * `Spells.TypeOfResists` — format 20, verbatim, for the reason `tg` is.
   * Omitted for `0`, the realm's *never resisted*, which reads back as the
   * cast that lands.
   */
  res?: number;
  /**
   * What this spell does to somebody standing in a room that casts it, and
   * what stops it — format 30. Written only for the spells rooms actually
   * cast, and only where the chain reaches harm, a relocation or something
   * this client cannot read. See `spellHazard.ts`.
   */
  hz?: BuiltSpellHazard;
}

/**
 * A room spell's effect on whoever is in the room, resolved at build time.
 *
 * Short keys like every other row in this file, which is tens of thousands of
 * lines of JSON. `d` is hit points a tick; `av` the items that stop it; `sp`
 * the spells that do; `tp` that it moves the character; `u` that the chain ran
 * into something the reader could not follow — which is discouraging, never
 * reassuring.
 */
export interface BuiltSpellHazard {
  d?: number;
  av?: number[];
  sp?: number[];
  tp?: 1;
  /** 1 when the chain can put a monster in the room. Format 31. */
  sm?: 1;
  u?: 1;
  /**
   * The level bands the realm gates `d`, `tp` and `sm` behind, where it gates
   * them at all — format 46. `[min, max]`, with `null` on either side for
   * unbounded. Absent per effect is ungated.
   */
  lv?: {
    d?: [number | null, number | null];
    tp?: [number | null, number | null];
    sm?: [number | null, number | null];
  };
}

/**
 * One row's fighting profile on disk — format 20 — in the compact shape the
 * rest of the file uses. `a` is the attack slots, each `[1, chance, accuracy,
 * min, max, energy, hitSpell]` for a blow or `[2, chance, spell, castChance,
 * level, energy]` for a cast in a blow's place; `c` is the between-round
 * spells, each `[spell, chance, level]`. Both omitted when empty; a row with
 * neither is not written at all. `WorldGraph.readProfiles` is the reader.
 */
export interface BuiltProfile {
  a?: number[][];
  c?: number[][];
}

/**
 * A race the realm offers, and the six stat ranges that distinguish one.
 *
 * The `Races` table is thirteen rows, and every one of them is a word the wire
 * prints on `look <player>` and in a gang listing — `Soul is a thin, moderately
 * built **Human Warrior**`. It was never indexed, so the two words that say
 * most about what somebody can do were the only ones on that line the client
 * could not answer a question about.
 *
 * The stat pair is a **range**, minimum to maximum, and both ends matter: the
 * minimum is what the race starts at and the maximum is the ceiling it can ever
 * train to, which is the number that decides whether a Half-Ogre Mage is a
 * plan or a mistake.
 */
export interface BuiltRace {
  id: number;
  n: string;
  /** `[minimum, maximum]` per stat, omitted where the realm states neither. */
  int?: [number, number];
  wil?: [number, number];
  str?: [number, number];
  hea?: [number, number];
  agl?: [number, number];
  chm?: [number, number];
  /** Extra hit points per level, over what the class gives. Absent when none. */
  hpPerLevel?: number;
  /**
   * The experience multiplier, as a percentage: a race on 150 needs half again
   * as much experience per level as one on 100. Kept verbatim — the realm's own
   * number, not converted, because nothing here has measured what it scales.
   */
  expTable?: number;
  /**
   * `Abil-n` / `AbilVal-n` — format 14, and the same pairs an item carries.
   *
   * Written verbatim, decoded by `src/shared/abilities.ts` at the point of
   * display. See `abilityPairs`.
   */
  ab?: Array<[number, number]>;
}

/**
 * A class the realm offers.
 *
 * Fifteen rows, and the other half of `Human Warrior`. Only the fields whose
 * meaning is settled are carried: `MinHits`/`MaxHits` are **not**, because the
 * first is larger than the second in all fifteen rows (`7-4`, `5-3`) and
 * nothing read so far says which way round they are — a hit-dice range printed
 * backwards is a claim the realm data does not make. `MageryType` is likewise
 * left out: it is 0 through 5 and only 0 (no magery at all) is certain, so the
 * *level* is carried and the numbering is not invented.
 */
export interface BuiltClass {
  id: number;
  n: string;
  /** Experience multiplier as a percentage, as on a race. */
  expTable?: number;
  /** Magery level, 1–3. Absent for a class that casts nothing. */
  magery?: number;
  /** How well it fights, on the realm's own 1–7 scale. */
  combat?: number;
  /**
   * `Abil-n` / `AbilVal-n` — format 14, and the same pairs an item carries.
   *
   * Written verbatim, decoded by `src/shared/abilities.ts` at the point of
   * display. See `abilityPairs`.
   */
  ab?: Array<[number, number]>;
}

/**
 * A monster the realm can name a maximum health for.
 *
 * Keyed by **name**, because a name is all the wire ever gives: `You slash the
 * giant rat for 12 damage!` carries no number, and nothing in the stream ever
 * names a monster's record id. The realm data is keyed by id and several rows
 * frequently share a name — a `cocoon` is five different monsters between 100
 * and 250 health — so a name genuinely resolves to a *range*, and this says so
 * rather than picking one and sounding certain.
 *
 * `hp` is the low end and `hi` the high, omitted when they agree. A consumer
 * showing a bar works from the **high** end: over-stating a monster's health
 * makes it die sooner than the bar promised, and under-stating it says "nearly
 * dead" about something that is not, which is the error that gets a character
 * killed.
 */
export interface BuiltMob {
  /** Lowercased and trimmed — the form the wire produces after the article. */
  n: string;
  /**
   * The realm's own numbers for every row sharing this name. Format 9: a
   * lair names its monsters by number (`(Max 2): 781,190,`) and the number
   * is the only key the room table has for them.
   */
  i?: number[];
  /**
   * Each row in `i`, in `i`'s order, answering for itself — format 32.
   *
   * The fold above is right for a name nothing can place, and wrong wherever
   * the row *is* known: weighed by name, a 100-HP gnoll scout became the
   * 830-HP one that shares its name, and a guard post was called deadly to a
   * character it could barely hit. A lair names its rows outright (format 31)
   * and a room resolves a name standing in it to one of them
   * (`WorldGraph.resolveMobRow`), and both then want the row's own numbers
   * rather than the worst of its twins'.
   *
   * Written **only where `i` holds more than one row**: with one row the fold
   * is that row already, and writing it twice would be the same fact in two
   * places for every one of the realm's 1,300 unshared names.
   */
  rw?: BuiltMobRow[];
  /** Lowest maximum health any row with this name has. */
  hp: number;
  /** Highest, when the rows disagree. Absent when they do not. */
  hi?: number;
  /**
   * Whether it starts the fight: `h`, `g`, `e` or `p`. See `shared/mobs.ts`.
   *
   * A letter rather than a word because it is written once per name into a file
   * that ships with the client, and the word buys nothing a lookup does not.
   * Absent when the realm states neither column, which is a realm that cannot
   * answer the question rather than one whose monsters are all peaceable.
   */
  d?: string;
  /** 1 when the rows sharing this name disagree about `d`. Absent otherwise. */
  x?: 1;
  /**
   * What it is worth, and what it costs to take — format 12.
   *
   * Every one of these is a **span collapsed to the answer that cannot get
   * somebody killed**, on the rule the health span already follows and for the
   * same reason: a name resolves to several rows, and the reassuring end of a
   * range is the dangerous one to act on.
   *
   * - `ac`, `dr`, `mr` take the **highest** of the rows: the hardest to hit,
   *   the most absorbed, the most resistant.
   * - `xp` takes the **lowest**: the least it might be worth.
   * - `rgn` takes the **highest**: never claim a monster is closer to death
   *   than it is. It is per regeneration tick, and the tick is realm-wide —
   *   see `MOB_REGEN_ROUNDS` in `src/shared/mobs.ts`.
   * - `fol` takes the **highest**: assume it follows when you leave.
   * - `und` is set when *any* row sharing the name is undead.
   *
   * All absent where no row states them, which is a realm that does not say
   * rather than a monster with no armour.
   */
  ac?: number;
  dr?: number;
  mr?: number;
  xp?: number;
  rgn?: number;
  fol?: number;
  und?: 1;
  /**
   * `Monsters.RegenTime`, hours — format 36.
   *
   * The clock is the one per-row column with no fold, and `rw` is written only
   * where a name holds several rows, so for a *uniquely named* monster — which
   * is what a boss is — it reached nothing: 305 of Paradigm's 381 stated
   * clocks and 228 of stock's 311 were dropped, and the survey priced a
   * 1,500-point Gravedigger on an hour's regeneration as though it came back
   * with the skeletons around it.
   *
   * Not a span collapsed to its worst end like the magnitudes above, because
   * a clock is not a magnitude: `0` means *on the room's own clock*, so
   * `wild dog [0,0,1]` folded to its highest would price an ordinary lair row
   * at one an hour. Written **only where every row of the name agrees**,
   * silence counted as a voice — the rule `SlotLoreEntry` already follows for
   * the realm's slot words. Disagreement states nothing rather than voting,
   * and costs nothing: a name holding several rows carries `rw`, so a lair or
   * a resident still resolves its own row outright.
   */
  rt?: number;
  /**
   * What it drops, by item name, capped — format 12.
   *
   * The reverse of `BuiltItem.mobs`, which has always been built: that answers
   * *where do I get one of these* and this answers *what is in this thing*,
   * and they are the two halves of the question every MUD player asks about a
   * monster. Names rather than numbers, because a number is not something
   * anybody can act on and the item index does not carry every item.
   */
  drops?: string[];
  /**
   * `Monsters.Type`, undecoded — format 18.
   *
   * Every distinct value the rows sharing this name state, gathered rather
   * than reduced, because there is no reading to reduce *toward*. Measured
   * 2026-09-02 on the shipped realm: four values (905 / 221 / 247 / 460) and
   * none of the obvious readings survives — it does not separate named
   * characters from wandering monsters (69% of the largest value are
   * lower-case), nor greeters from mutes, nor the charmable from the rest. It
   * is carried so a later capture can decode it without reconverting every
   * realm, and read by nothing until one does.
   */
  ty?: number[];
  /**
   * The average damage a blow does, from `Monsters.AvgDmg` — format 18.
   *
   * The **highest** of the rows sharing the name, on the rule every other span
   * here follows: the reassuring end of a range is the dangerous one to act
   * on.
   */
  dmg?: number;
  /** `Monsters.CharmLVL` — the level at which it can be charmed. Format 18. */
  chl?: number;
  /**
   * The spells it casts mid-fight and on death — `MidSpell-0..4` and
   * `DeathSpell`, as realm spell ids. Format 18.
   *
   * The fact behind *avoid anything that casts a death spell*: a monster that
   * detonates when it dies is one an automation should decline, and nothing in
   * the stream says so until it has already happened.
   */
  cast?: number[];
  ds?: number;
  /**
   * How each row sharing this name fights — format 20, one entry per
   * *distinct* row profile, in the order the rows came.
   *
   * Per row and not folded, which is the one place besides `ab` this file
   * refuses to reduce, and for a different reason: `ab` cannot be reduced
   * without a display judgement, and this cannot be reduced without the
   * *character* — which of two rows is the more dangerous depends on the
   * armour class standing in front of them. `src/shared/menace.ts` folds it
   * at the moment of the decision. See `BuiltProfile` for the shape.
   */
  pf?: BuiltProfile[];
  /**
   * Whether attacking one costs ten evil points: `a` always, `s` sometimes.
   *
   * Absent means never. Its own field rather than something derivable from `d`,
   * because the two questions come apart: a `LawfulGood` monster on a gate is
   * `passive` and still charges for being hit. `s` is the case where the rows
   * sharing a name disagree — see `AlignmentCost`.
   */
  ep?: 'a' | 's';
  /**
   * `Abil-n` / `AbilVal-n` — format 14. What it resists, what it ignores, what
   * it calls for help.
   *
   * **Every distinct value every row sharing the name states**, gathered and
   * not reduced — which is the one place this differs from `hp`, `ac` and the
   * rest, and deliberately.
   *
   * It matters: 100 of the 234 shared names disagree about their effects, and
   * `zombie` is three rows where one is 100% cold-resistant and another is
   * not. The first attempt folded to the maximum on the reasoning `hp` uses —
   * the reassuring end of a range is the dangerous one to plan a fight on —
   * and that is right for a magnitude and wrong for a row id. `SpellImmu 40`
   * and `45` are two different spells rather than a bigger number, and
   * `dwarven warrior` row 446 states `MonsGuards` twice in one row; a maximum
   * silently dropped one of each.
   *
   * Choosing per id would mean reading `ABILITY_SHAPE` here, and that is the
   * display judgement this file refuses to make — see `BuiltItem.ab`. So the
   * realm's own answer is written whole and the card reduces it
   * (`effectValues`), where the shape is known and a correction to it takes
   * effect without a rebuild.
   */
  ab?: Array<[number, number]>;
}

/**
 * One of the realm's `Monsters` rows, answering for itself — format 32.
 *
 * Every field here is the same column `BuiltMob` folds, taken from this row
 * alone and folded with nothing. The fold is the answer for a name nothing
 * can place to a row; this is the answer wherever something can, and the two
 * are different questions rather than two accuracies of one.
 *
 * The short keys match `BuiltMob`'s so a reader can overlay one on the other
 * field by field. Absent means *this row states no such column*, which is the
 * same absence `BuiltMob` uses and reads the same way: not zero.
 */
export interface BuiltMobRow {
  /** Index into `BuiltMob.pf`, absent for a row that states no attack at all. */
  p?: number;
  /** This row's `Monsters.Align`/`Type` reading, absent where it states none. */
  d?: string;
  /** `Monsters.HP` — this row's own maximum, never a span. */
  hp: number;
  ac?: number;
  dr?: number;
  mr?: number;
  xp?: number;
  rgn?: number;
  /** `Monsters.RegenTime`, hours: a placed monster's clock (format 33). */
  rt?: number;
  fol?: number;
  dmg?: number;
  chl?: number;
  und?: 1;
}

/**
 * `1/41 (Door [1000 picklocks/strength])` → destination plus raw instruction.
 * `0` means no exit at all.
 */
/**
 * One exit as the world file writes it: where it goes, the realm's own
 * instruction, and — format 23 — the levers that open it where they are all in
 * the room it leaves from. See `RequirementAction`.
 */
export interface BuiltExit {
  m: number;
  r: number;
  i?: string;
  a?: RequirementAction[];
}

/**
 * A lever as the first pass found it, before either join.
 *
 * `in` is the room whose column held it — where it is pulled. `at` is the room
 * whose exit it opens, which is usually but not always the same one. Keeping
 * both is the whole of what makes the two joins possible, and the difference
 * between them is what decides whether an exit can be opened where it stands.
 */
interface Lever {
  in: { map: number; room: number };
  at: { map: number; room: number };
  direction: string;
  say: string[];
  /** The item the realm says must be carried to pull it. See `parseAction`. */
  item?: number;
  index?: number;
}

export function parseExit(raw: unknown): BuiltExit | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (text.length === 0 || text === '0') return null;
  const match = /^(\d+)\/(\d+)(?:\s*\((.+)\))?$/.exec(text);
  if (!match) return null;
  const exit: BuiltExit = {
    m: Number(match[1]),
    r: Number(match[2])
  };
  if (match[3]) exit.i = match[3];
  return exit;
}

/**
 * `Rooms.Placed` as item numbers — format 42.
 *
 * Stored as a comma-*terminated* list (`1410,1417,`), which is the shape the
 * server's own reader walked comma by comma (`Room.GetPlacedItems`, now
 * commented out; the import fills `RoomPlacedItems` from `Placed Item 0..9`
 * columns, the same fact in another shape). A token
 * that is not a positive whole number is dropped rather than repaired; a
 * repeat is one item, since the server puts one back only where none lies
 * (`LoadPlacedItems`) — 15 of Paradigm's 77 coffin rooms repeat it, up to
 * four times; and a number the item table lacks is kept: the server skips it
 * (`RoomManager`'s `TryGetValue`), and the reader drops what it cannot name.
 */
export function placedItems(raw: unknown): number[] {
  if (raw === null || raw === undefined) return [];
  const ids: number[] = [];
  for (const token of String(raw).split(',')) {
    const id = Number(token.trim());
    if (token.trim().length > 0 && Number.isInteger(id) && id > 0 && !ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
}

/**
 * What a *blank* looks like once a text value has been read out of a numeric
 * column: `0x2020`, two ASCII spaces, little-endian.
 *
 * 348 rows of the shipped realm's `Items.Speed` read as this. Nothing in the
 * database distinguishes it from a real 8224, and no column in it has a
 * plausible value there — weapon speeds run 900–3000, a monster's armour class
 * tops out at 9999 — so it is refused wherever a new column is read. It costs
 * one impossible value and removes the whole class of bug where an empty cell
 * becomes a confident number.
 */
export const BLANK_AS_NUMBER = 8224;

/**
 * A monster's own regeneration clock in hours, or null where it has none —
 * format 36.
 *
 * `Monsters.RegenTime` is **not** a clock on its own: `RegenSlot.Regenerate`
 * consults `MobType.Regen` only down the `GameLimit != 0` branch
 * (`RegenSlot.cs:69`), where the server counts the instances of that monster
 * alive in the world and holds a killed one for `Regen * 3600` seconds. With
 * `GameLimit == 0` the slot respawns on the room's own `GetDelayInSeconds()`
 * and the column is never read (`RegenSlot.cs:39-54`). Five rows in the two
 * shipped archives state a `RegenTime` the server ignores — stock's `minotaur`
 * (48 hours, in 25 lairs on a five-minute delay) among them — and weighting
 * their experience by a clock nothing runs would take those lairs off the
 * card entirely.
 *
 * Read from the server's own source rather than guessed: `docs/greatermud/`.
 */
function ownClock(row: Record<string, unknown>): number | null {
  const limit = number(row['GameLimit']);
  if (limit === null || limit === 0 || limit === BLANK_AS_NUMBER) return null;
  const hours = number(row['RegenTime']);
  return hours === null || hours <= 0 || hours === BLANK_AS_NUMBER ? null : hours;
}

/**
 * How many `Abil-n` slots a row has.
 *
 * Twenty on `Items` and ten on `Monsters`, `Spells`, `Races` and `Classes`;
 * reading twenty everywhere is safe because a column that is not there reads as
 * absent, and one number is one fewer thing to keep in step with the schema.
 */
export const ABILITY_SLOTS = 20;

/**
 * How many `ClassRest-n` / `RaceRest-n` slots an item row has.
 *
 * Ten of each on `Items`, and the same argument as `ABILITY_SLOTS`: a column
 * that is not there reads as absent, so one number covers every derivative.
 */
export const RESTRICTION_SLOTS = 10;

/**
 * `MidSpell-0..4` on `Monsters`, and the same argument as `ABILITY_SLOTS`: a
 * column count the realm fixed, read as a bound rather than discovered.
 */
export const MID_SPELL_SLOTS = 5;

/** `Attack Type 0`–`4`: the five attack slot groups a monster row carries. */
export const ATTACK_SLOTS = 5;

/**
 * The effective chance of each attack slot, transcribed from
 * `Mob.GetAttackType` rather than derived from it.
 *
 * The realm stores the slots' `Att%` as **cumulative thresholds**: one roll
 * of 1–100 walks the slots in order and takes the first whose threshold covers
 * it, with `covered` advanced to each slot's threshold whether or not it
 * matched — so a threshold *lower* than the one before it can never fire and
 * pulls the floor back down for the slot after. A roll above the last
 * threshold falls back to the first slot. That is a loop with two quirks, so
 * the hundred rolls are walked exactly as the server walks them and counted,
 * rather than turned into arithmetic that would have to get both quirks
 * right.
 *
 * The editor's `AttTrue%` column is **not** read, and not because it is
 * redundant: measured 2026-09-04 over the 1,610 GMUD rows whose column
 * states a total of 100, it agrees with this walk within a point on half the
 * slots and disagrees by up to 73 points on others (`hooded man`, thresholds
 * 5/100, stated 78.3 for the first slot where the server rolls it 5 times in
 * 100). Whatever model produced it, it is not this server's loop, and a
 * cached column that can be edited out from under is exactly the kind of
 * figure the wire outranks. `profiles.realm.test.ts` keeps the measurement.
 */
export function attackChances(thresholds: readonly number[]): number[] {
  const counts = thresholds.map(() => 0);
  if (thresholds.length === 0) return counts;
  for (let roll = 1; roll <= 100; roll += 1) {
    let covered = 0;
    let taken = -1;
    for (let slot = 0; slot < thresholds.length; slot += 1) {
      const threshold = thresholds[slot]!;
      if (roll > covered && roll <= threshold) {
        taken = slot;
        break;
      }
      covered = threshold;
    }
    const landed = taken === -1 ? 0 : taken;
    counts[landed] = (counts[landed] ?? 0) + 1;
  }
  return counts.map((count) => count / 100);
}

/**
 * The marginal per-round chance of each between-round spell, transcribed
 * from the loop in `TimedEventManager` that fires them.
 *
 * **One roll per monster per round**, checked against each slot's `Spell
 * Cast %` in order, and the first slot it falls under fires — so the column
 * is a cumulative figure too, and a second slot at 20% behind a first at 10%
 * fires on a tenth of rounds. Walked and counted for the reason
 * `attackChances` is.
 */
export function castChances(thresholds: readonly number[]): number[] {
  const counts = thresholds.map(() => 0);
  for (let roll = 1; roll <= 100; roll += 1) {
    const slot = thresholds.findIndex((threshold) => roll <= threshold);
    if (slot !== -1) counts[slot] = (counts[slot] ?? 0) + 1;
  }
  return counts.map((count) => count / 100);
}

/**
 * One monster row's fighting profile, or null for a row that states neither
 * an attack nor a between-round spell.
 *
 * Only slot types 1 (a blow) and 2 (a spell in a blow's place) are loaded,
 * because those are the only two `MobType.GetAttackTypes` loads — the GMUD
 * database's one `3`, on the first `giant rat` row, is a slot the server never
 * rolls. A slot the walk gives no chance to is left out the same way: it is
 * not an attack this monster can make.
 */
export function rowProfile(row: Record<string, unknown>): MobProfile | null {
  const cell = (value: unknown): number => {
    const figure = number(value);
    return figure === null || figure === BLANK_AS_NUMBER ? 0 : figure;
  };

  const slots: Array<{
    type: number;
    threshold: number;
    figure: number;
    min: number;
    max: number;
    energy: number;
    hit: number;
  }> = [];
  for (let slot = 0; slot < ATTACK_SLOTS; slot += 1) {
    const type = number(row[`AttType-${slot}`]);
    if (type !== 1 && type !== 2) continue;
    slots.push({
      type,
      threshold: cell(row[`Att%-${slot}`]),
      figure: cell(row[`AttAcc-${slot}`]),
      min: cell(row[`AttMin-${slot}`]),
      max: cell(row[`AttMax-${slot}`]),
      energy: cell(row[`AttEnergy-${slot}`]),
      hit: cell(row[`AttHitSpell-${slot}`])
    });
  }
  const chances = attackChances(slots.map((slot) => slot.threshold));
  const attacks: MobAttack[] = [];
  slots.forEach((slot, index) => {
    const chance = chances[index] ?? 0;
    if (chance <= 0) return;
    if (slot.type === 1) {
      const attack: MobAttack = {
        kind: 'melee',
        chance,
        accuracy: slot.figure,
        min: slot.min,
        max: slot.max,
        energy: slot.energy
      };
      if (slot.hit > 0) attack.onHit = slot.hit;
      attacks.push(attack);
    } else if (slot.figure > 0) {
      // `Attack Accu/Spell` is the spell id, `Min Hit/Cast %` the chance the
      // cast succeeds, `Max Hit/Cast LVL` the level it is cast at.
      attacks.push({
        kind: 'spell',
        chance,
        spell: slot.figure,
        castChance: Math.min(100, Math.max(0, slot.min)) / 100,
        level: slot.max,
        energy: slot.energy
      });
    }
  });

  const named: Array<{ spell: number; threshold: number; level: number }> = [];
  for (let slot = 0; slot < MID_SPELL_SLOTS; slot += 1) {
    const spell = cell(row[`MidSpell-${slot}`]);
    if (spell <= 0) continue;
    named.push({
      spell,
      threshold: cell(row[`MidSpell%-${slot}`]),
      level: cell(row[`MidSpellLVL-${slot}`])
    });
  }
  const odds = castChances(named.map((each) => each.threshold));
  const casts: MobCast[] = [];
  named.forEach((each, index) => {
    const chance = odds[index] ?? 0;
    if (chance > 0) casts.push({ spell: each.spell, chance, level: each.level });
  });

  if (attacks.length === 0 && casts.length === 0) return null;
  return { attacks, casts };
}

/** `MobProfile` in the file's compact shape — see `BuiltProfile`. */
function compactProfile(profile: MobProfile): BuiltProfile {
  const out: BuiltProfile = {};
  if (profile.attacks.length > 0) {
    out.a = profile.attacks.map((attack) =>
      attack.kind === 'melee'
        ? [
            1,
            attack.chance,
            attack.accuracy,
            attack.min,
            attack.max,
            attack.energy,
            attack.onHit ?? 0
          ]
        : [2, attack.chance, attack.spell, attack.castChance, attack.level, attack.energy]
    );
  }
  if (profile.casts.length > 0) {
    out.c = profile.casts.map((cast) => [cast.spell, cast.chance, cast.level]);
  }
  return out;
}

/**
 * The `Abil-n` / `AbilVal-n` pairs on one row, in slot order and undecoded.
 *
 * Five tables carry them — `Items`, `Monsters`, `Spells`, `Races` and
 * `Classes` — and until 2026-08-31 only the item half was ever written out, so
 * the client showed a spell's level and mana and never what casting it does. A
 * shared reader rather than the loop copied five times: the empty-slot rule
 * (`0`) and the blank-cell rule (`8224`) are properties of the *format*, and
 * five copies of them is five places for one of them to be forgotten.
 *
 * Kept as the realm's own numbers; `src/shared/abilities.ts` names them at the
 * point of display, because the reading is a claim from another client's
 * source and may be corrected while the number is what the realm said.
 */
export function abilityPairs(row: Record<string, unknown>): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  for (let slot = 0; slot < ABILITY_SLOTS; slot += 1) {
    const which = number(row[`Abil-${slot}`]);
    if (which === null || which <= 0 || which === BLANK_AS_NUMBER) continue;
    const value = number(row[`AbilVal-${slot}`]);
    pairs.push([which, value === null || value === BLANK_AS_NUMBER ? 0 : value]);
  }
  return pairs;
}

/**
 * Every spell that moves whoever it lands on to one fixed room, as
 * `map/room` by spell number — format 29.
 *
 * `TeleportRoom` and `TeleportMap` are two ability slots on the spell row,
 * and a room script's `cast <spell>` step is how three of Paradigm's holes
 * are walked: `go hole:message 774:cast 336:message 766:text 306`, where
 * spell 336 (*fall*) carries `140 → 1306`, `141 → 2`. Eighteen spells on the
 * Paradigm database and twelve on stock state both halves; a spell stating
 * one half, or a zero, moves nobody anywhere this reader can name and is
 * left out. The same pair `resolveSpells` reads for a `Cast:` exit.
 */
export function spellLandings(source: RealmSource): Map<number, string> {
  const landings = new Map<number, string>();
  for (const row of source.table('Spells')?.rows ?? []) {
    const id = number(row['Number']);
    if (id === null) continue;
    let room: number | null = null;
    let map: number | null = null;
    for (const [which, value] of abilityPairs(row)) {
      if (which === HAZARD_ABILITY.teleportRoom) room = value;
      else if (which === HAZARD_ABILITY.teleportMap) map = value;
    }
    if (room !== null && map !== null && room > 0 && map > 0) landings.set(id, `${map}/${room}`);
  }
  return landings;
}

export class RealmBuildError extends Error {}

/**
 * Reads a whole realm and returns what to write.
 *
 * Refuses rather than producing a confident empty realm: a file with no `Rooms`
 * table, or one whose rooms carry no usable coordinates, is a file somebody
 * pointed at by mistake — and a client that accepts it stops knowing where it
 * is with nothing on screen saying why.
 */
export function buildRealm(source: RealmSource, today: string, shipped?: ShippedBuild): BuiltRealm {
  const rooms = source.table('Rooms');
  if (rooms === null) {
    throw new RealmBuildError(
      `${source.path} has no Rooms table. Its tables are: ${source.tableNames().join(', ') || '(none)'}.`
    );
  }

  /*
   * Rooms are held as objects and serialised at the end rather than as they are
   * read, because a room's command script names items and the item index is
   * built from what every room, shop and monster between them asked for. One
   * pass could not name a key it had not finished collecting.
   */
  const drafts: Array<{ room: Record<string, unknown>; cmd: number | null }> = [];
  /** Item numbers an exit refers to, so only those need naming. */
  const neededItems = new Set<number>();

  /*
   * The words each room answers, from `Rooms.CMD` into `TBInfo.Action`.
   *
   * Read before the room loop because the item index is built after it and the
   * scripts name 192 items of their own — a script that says `roomitem 3389` is
   * telling nobody anything, and `roomitem shimmering key` is telling them
   * where to start. See `roomScript.ts` for what this table is and why the
   * router is deliberately not given its thousand teleports yet.
   */
  const scripts = new Map<number, string>();
  /*
   * And what each block runs on next, which a room's script never needs and a
   * monster's greeting always does: a greeting is a keyword table, and the
   * lever behind it is a block or two further down the chain (`leversAsked`).
   */
  const chains = new Map<number, number>();
  for (const row of source.table('TBInfo')?.rows ?? []) {
    const id = number(row['Number']);
    // A `TBInfo` action is stored with trailing NULs; they are padding, not text.
    const action = text(row['Action']).replaceAll('\u0000', '').trim();
    if (id === null) continue;
    if (action.length > 0) scripts.set(id, action);
    const linkTo = number(row['LinkTo']);
    if (linkTo !== null && linkTo > 0) chains.set(id, linkTo);
  }
  // Where a script's `cast` lands, for the phrases whose only movement is a
  // spell (format 29). Read here, once, because the spell index is built
  // after the rooms and a room's commands are converted inside the room loop.
  const landings = spellLandings(source);
  const scriptedRooms = new Set<number>();
  for (const row of rooms.rows) {
    const cmd = number(row['CMD']);
    if (cmd !== null && cmd > 0 && scripts.has(cmd)) scriptedRooms.add(cmd);
  }
  for (const id of itemsInScripts([...scriptedRooms].map((id) => scripts.get(id) ?? ''))) {
    neededItems.add(id);
  }
  let withExits = 0;
  let withInstructions = 0;
  let placed = 0;
  /*
   * Every lever in the realm, collected on the first pass and joined on the
   * second — the exit a lever opens is usually in another row and sometimes in
   * another map, so neither half can be finished while the rows are being read.
   */
  const levers: Lever[] = [];

  // Sorted the way the build script's query sorted, so a realm converted at
  // runtime and one built at build time produce byte-identical output.
  const ordered = [...rooms.rows].sort(
    (a, b) =>
      (number(a['Map Number']) ?? 0) - (number(b['Map Number']) ?? 0) ||
      (number(a['Room Number']) ?? 0) - (number(b['Room Number']) ?? 0)
  );

  for (const row of ordered) {
    const map = number(row['Map Number']);
    const roomNumber = number(row['Room Number']);
    // A room with no address cannot be reached, referred to or drawn. Skipped
    // rather than given a zero, which would collide with every other skipped
    // room at 0/0.
    if (map === null || roomNumber === null) continue;
    placed += 1;

    const exits: Record<string, BuiltExit> = {};
    for (const direction of DIRECTIONS) {
      const exit = parseExit(row[direction]);
      if (!exit) {
        /*
         * A direction column that is not a destination is a **lever** — format
         * 23. Both databases on this machine hold 299 of them and the
         * converter has dropped every one since it was written; see
         * `parseAction`. The storage column is a slot, not a direction, so
         * what is kept is which exit the lever opens and where it is pulled.
         */
        const lever = parseAction(row[direction]);
        if (lever) {
          levers.push({
            in: { map, room: roomNumber },
            at: { map: lever.map ?? map, room: lever.room ?? roomNumber },
            direction: lever.direction,
            say: lever.say,
            ...(lever.item === undefined ? {} : { item: lever.item }),
            ...(lever.index === undefined ? {} : { index: lever.index })
          });
          // Named like a keyed door's key, so the refusal can say *amber
          // talisman* rather than *item 815*.
          if (lever.item !== undefined) neededItems.add(lever.item);
        }
        continue;
      }
      exits[direction.toLowerCase()] = exit;
      if (exit.i) {
        withInstructions += 1;
        for (const match of exit.i.matchAll(/(?:Key|Item):\s*(\d+)/g)) {
          neededItems.add(Number(match[1]));
        }
      }
    }
    if (Object.keys(exits).length > 0) withExits += 1;

    const room: Record<string, unknown> = {
      m: map,
      r: roomNumber,
      n: text(row['Name']),
      x: exits
    };
    // Optional columns, omitted when empty so the file stays small.
    if (row['Shop']) room['s'] = row['Shop'];
    if (row['NPC']) room['npc'] = row['NPC'];
    if (row['Light']) room['li'] = row['Light'];
    /*
     * The spell the room casts on whoever is standing in it — format 13.
     * 13,016 of the shipped realm's 55,806 rooms carry one, and it resolves
     * cleanly against the spell table: `bigheal`, `inn rest`, `stop drowning`,
     * `web spell`, `under level teleport`. Kept as the realm's id and named at
     * the point of display, like every other id here.
     */
    if (row['Spell']) room['sp'] = row['Spell'];
    if (row['Lair'] && row['Lair'] !== '') room['lair'] = row['Lair'];
    /*
     * The lair's respawn clock — format 33. As the realm states it, unit rules
     * and the family's offset applied where it is read (`respawnSeconds`), so
     * a MajorMUD conversion and a GreaterMUD one carry the same column.
     * Omitted at zero: no clock is stated, not a clock of nothing.
     */
    const delay = number(row['Delay']);
    if (delay !== null && delay !== 0 && delay !== BLANK_AS_NUMBER) room['dl'] = delay;
    /*
     * What the realm puts on this room's floor and puts back at the nightly
     * cleanup, within each item's game limit — format 42
     * (`docs/greatermud/rooms-and-items.md` › *The nightly cleanup*). Written as the raw string since the file began and read by
     * nothing; ids now, and each one named, since the room refers to it the
     * way a shop refers to its stock.
     */
    const furnished = placedItems(row['Placed']);
    if (furnished.length > 0) {
      room['pl'] = furnished;
      for (const id of furnished) neededItems.add(id);
    }

    /*
     * And the levers this room's own script pulls — the same fact the
     * direction columns state, in the spelling `leversInScript` reads. Read
     * here rather than beside `parseRoomScript` below because both joins are
     * made from this one list and neither can be made while the rows are
     * still being read: the exit a lever opens is usually another row's.
     *
     * The script names the room alone and the server resolves it on the map
     * the player is standing on, which is this room's — so the map is filled
     * in from here and never from the script.
     */
    const script = number(row['CMD']);
    for (const lever of leversInScript(script === null ? '' : (scripts.get(script) ?? ''))) {
      levers.push({
        in: { map, room: roomNumber },
        at: { map, room: lever.room ?? roomNumber },
        direction: lever.direction,
        say: lever.say,
        ...(lever.item === undefined ? {} : { item: lever.item }),
        ...(lever.index === undefined ? {} : { index: lever.index })
      });
      if (lever.item !== undefined) neededItems.add(lever.item);
    }

    drafts.push({ room, cmd: script });
  }

  /*
   * And the levers behind a conversation — format 38's second half.
   *
   * A monster's greeting reaches a script like any other and five of them
   * (identically in both databases) end in a `remoteaction`: the shadow guard
   * who opens the door to Morukai, and four stone sphinxes who open the way up
   * out of the room they sit in. See `leversAsked` for why the join is safe.
   *
   * **Only where the realm places the monster in the very room the step
   * names.** `remoteaction` states a room number and the server resolves it on
   * the map the player is standing on, so the map has to come from somewhere:
   * `Summoned By` is the realm's own list of where this monster is put, and a
   * placement whose room number the step names is the room the asking happens
   * in. Every placement that matches is kept, because the server's rule is
   * literally *this number, on your map* — a monster standing at 12/1920 and
   * 5/1920 opens whichever of the two the player is in.
   */
  for (const row of source.table('Monsters')?.rows ?? []) {
    const greet = number(row['GreetTXT']);
    const who = text(row['Name']).trim();
    if (greet === null || greet <= 0 || who.length === 0) continue;
    const asked = leversAsked(greet, who, (id) => {
      const action = scripts.get(id);
      const linkTo = chains.get(id) ?? 0;
      /*
       * A block with **no action at all** is still a link in the chain: 1435,
       * between the shadow guard's keyword table and the `remoteaction` that
       * opens the door, holds nothing but a `LinkTo`. Reading it as absent
       * ends the walk one block short of every lever there is.
       */
      return action === undefined && linkTo === 0 ? undefined : { action: action ?? '', linkTo };
    });
    if (asked.length === 0) continue;

    const places: Array<{ map: number; room: number }> = [];
    for (const match of text(row['Summoned By']).matchAll(/(\d+)\s*\/\s*(\d+)/g)) {
      places.push({ map: Number(match[1]), room: Number(match[2]) });
    }
    for (const lever of asked) {
      for (const place of places) {
        if (place.room !== lever.room) continue;
        levers.push({
          in: place,
          at: { map: place.map, room: place.room },
          direction: lever.direction,
          say: lever.say,
          ...(lever.item === undefined ? {} : { item: lever.item }),
          ...(lever.index === undefined ? {} : { index: lever.index })
        });
        if (lever.item !== undefined) neededItems.add(lever.item);
      }
    }
  }

  if (placed === 0) {
    throw new RealmBuildError(
      `${source.path} has a Rooms table with no addressable rooms in it. ` +
        'Expected "Map Number" and "Room Number" columns.'
    );
  }

  /*
   * Shops first: what they stock decides which items need naming. An exit's key
   * and a shop's stock are the same question — "what is item 1124" — asked from
   * two directions, and answering it once is what keeps the file small enough
   * to ship.
   */
  const shops = indexShops(source);
  for (const shop of shops) for (const id of shop.items) neededItems.add(id);

  /*
   * And what monsters drop, so `BuiltMob.drops` can name something. 237 more
   * items on the shipped realm (1,506 → 1,743 of 2,639), which is the price of
   * being able to answer *what is in this thing* — the question every MUD
   * player asks about a monster and the one the client could not answer at all.
   */
  const monsterTable = source.table('Monsters');
  for (const row of monsterTable?.rows ?? []) {
    for (const [column, value] of Object.entries(row)) {
      if (!/^DropItem-\d+$/.test(column)) continue;
      const dropped = number(value);
      if (dropped !== null && dropped > 0) neededItems.add(dropped);
    }
  }

  /*
   * And what the realm's own scripts hand over — format 39.
   *
   * `indexSpells` is read here rather than beside the other tables below
   * because the walk needs it: a monster's `DeathSpell` reaches its text block
   * through the spell rows' `Abil-n` pairs, and re-reading `Spells` for them
   * would be a second opinion about the same columns.
   *
   * The walk is the realm's own reachability — every block a greeting, a room's
   * script or a death spell can run — and it answers two questions the item
   * index was getting wrong. `neededItems` was fed by exits, levers, shops,
   * monster drops and **room-owned** scripts, so `acid gland` (a white jelly's
   * death), `unfertilized eggs` (a queen ant's) and `double-terminated quartz`
   * (Leo the Quick's) were names with no row: no weight, no kind, and nothing
   * saying where to go. See `itemsInReach`.
   */
  const spells = indexSpells(source);
  const blocks = blocksInReach(source, spells);
  const fromScripts = itemsInReach(blocks);
  /*
   * And which items are *doors* — format 40. An item that casts a spell whose
   * text block teleports you is a way into somewhere, exactly as a key on a
   * corridor is, and no column says so. See `landingsOfItems`.
   */
  const itemLandings = landingsOfItems(source, spells, blocks);
  for (const id of fromScripts.named) neededItems.add(id);

  /*
   * What each room spell does to whoever stands in the room — format 30.
   *
   * Folded onto the spell rows rather than onto the 13,603 rooms that name
   * one: 159 distinct spells cover them, and repeating the same answer eight
   * hundred and forty-five times down the Silver River is a megabyte for
   * nothing. The rooms already carry the id.
   */
  const hazards = indexSpellHazards(source);
  for (const spell of spells) {
    const hazard = hazards.get(spell.id);
    if (hazard !== undefined) spell.hz = hazard;
  }

  const items = indexItems(source, neededItems, fromScripts.from, itemLandings);
  const named = new Map(items.map((item) => [item.id, item.n]));
  const mobs = indexMobs(source, named);

  /*
   * And now the rooms, with the words each one answers attached — format 13.
   * Serialised here rather than in the loop above because the phrases name
   * items, and the item index is only complete at this point.
   */
  /*
   * The levers, joined onto both ends — format 23.
   *
   * Two joins from one list, because a lever is two facts about two rooms: it
   * is a word the room holding it answers (`cmd`, with `opens` saying what
   * for), and it is what the gated exit needs (`Requirement.actions`, so the
   * router can price it and the walker can send it).
   */
  const byExit = new Map<string, Lever[]>();
  const byRoom = new Map<string, Lever[]>();
  /*
   * **The same lever stated twice is one lever.** The realm says it in two
   * columns (`12/2231` holds `Action#2 [on the E exit of room 12/2227]: push
   * onyx` in both its `E` and its `D` cell) and in a column *and* the room's
   * script (`8/560`'s `D` cell and its `turn wheel` line are the same wheel on
   * the same north exit). Kept as two, a lever counts twice against the
   * realm's own `Needs N Actions`, which is the test that decides whether an
   * exit can be opened where it stands — so the duplicate would quietly shut
   * a passage the realm says is openable.
   *
   * Identified by everything about it, so two levers that differ anywhere —
   * the exit, the phrases, the item, the order — stay two.
   */
  const seenLevers = new Set<string>();
  for (const lever of levers) {
    const identity = JSON.stringify([
      lever.in,
      lever.at,
      lever.direction,
      lever.say,
      lever.item ?? null,
      lever.index ?? null
    ]);
    if (seenLevers.has(identity)) continue;
    seenLevers.add(identity);
    const exitKey = `${lever.at.map}/${lever.at.room}:${lever.direction}`;
    const roomKey = `${lever.in.map}/${lever.in.room}`;
    (byExit.get(exitKey) ?? byExit.set(exitKey, []).get(exitKey)!).push(lever);
    (byRoom.get(roomKey) ?? byRoom.set(roomKey, []).get(roomKey)!).push(lever);
  }
  // The realm's own order where it numbers them, and the order the rows were
  // read in otherwise — which is what `any order` makes harmless.
  for (const found of byExit.values()) found.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  const lines: string[] = [];
  let scripted = 0;
  let levered = 0;
  /** Levers whose phrase several of the room's own commands answer to. */
  let ambiguousLevers = 0;
  let openableHere = 0;
  for (const { room, cmd } of drafts) {
    const action = cmd === null ? undefined : scripts.get(cmd);
    const answers =
      action === undefined
        ? []
        : parseRoomScript(
            action,
            (id) => named.get(id),
            (id) => landings.get(id)
          );
    if (answers.length > 0) scripted += 1;

    const here = `${room['m'] as number}/${room['r'] as number}`;
    /*
     * The levers pulled *in* this room become words it answers, each saying
     * which exit it opens. A lever whose exit is somewhere else says so with
     * its full address; one in this room says the direction alone, because
     * repeating the room somebody is standing in is noise.
     */
    const mine = byRoom.get(here) ?? [];
    for (const lever of mine) {
      const opens = {
        room: `${lever.at.map}/${lever.at.room}`,
        direction: lever.direction,
        ...(lever.item === undefined ? {} : { item: lever.item })
      };
      /*
       * A lever out of this room's own script is already one of the words the
       * script answers, and it is the *same* word: `parseRoomScript` has it
       * with its guards, this has what it opens. So the two halves go on one
       * command rather than printing `lift portcullis` twice, once with a
       * condition and once with a destination.
       *
       * **Matched on every spelling, and only where exactly one command has
       * it.** The two sides group differently — `parseRoomScript` folds lines
       * with identical steps, this folds lines that pull the same lever — so
       * a first phrase is not an identity, and two commands answering to one
       * word is an ambiguity rather than a licence for the last writer to
       * win. Neither shipped realm holds one; a player's own database is
       * converted through this same function.
       */
      const sharing = answers.filter((answer) =>
        answer.say.some((phrase) => lever.say.includes(phrase))
      );
      if (sharing.length === 1 && sharing[0]!.opens === undefined) sharing[0]!.opens = opens;
      else if (sharing.length === 0) answers.push({ say: lever.say, opens });
      // Said out loud, because a refusal is a decision and a decision nobody
      // can read did not happen. Neither shipped realm produces one; a
      // player's own database is converted through this same function.
      else ambiguousLevers += 1;
    }
    if (answers.length > 0) room['cmd'] = answers;
    if (mine.length > 0) levered += 1;

    /*
     * And the other end: an exit stating `Needs N Actions` gets the phrases,
     * but **only when the realm's count matches what was found and every one
     * of them is pulled in this very room**. Either half short and the exit
     * keeps the pricing it has always had: sending some of the levers for a
     * passage that needs more is a command spent on a wall, and a detour to
     * another room is a route this planner does not plan. What is recorded
     * either way is *where* each lever is, so the client can say so.
     */
    const exits = room['x'] as Record<string, BuiltExit>;
    for (const [direction, exit] of Object.entries(exits)) {
      if (exit.i === undefined) continue;
      const found = byExit.get(`${here}:${direction}`);
      if (found === undefined || found.length === 0) continue;
      const needs = /Needs\s+(\d+)\s+Actions?/i.exec(exit.i);
      if (needs === null || Number(needs[1]) !== found.length) continue;
      const acts = found.map((lever) => ({
        say: lever.say,
        ...(lever.item === undefined ? {} : { item: lever.item }),
        ...(lever.in.map === lever.at.map && lever.in.room === lever.at.room
          ? {}
          : { at: { map: lever.in.map, room: lever.in.room } })
      }));
      exit.a = acts;
      if (acts.every((act) => act.at === undefined)) openableHere += 1;
    }

    lines.push(JSON.stringify(room));
  }

  const races = indexRaces(source);
  const classes = indexClasses(source);
  const itemNames = indexItemNames(source);
  const build = indexBuild(source);
  const family = familyOfBuild(build);
  /*
   * The realm's quests, assembled from its own text blocks — the realm has no
   * Quests table and never had one. See `indexQuests.ts` for the derivation,
   * and why the counters are found rather than listed.
   *
   * Late, because it wants the class, race and spell indexes to name what a
   * step demands and pays, and re-reading those tables for a name would be a
   * second opinion about the same rows. The walk itself was made before the
   * item index, which needs it too — see `blocks` above.
   */
  const quests = indexQuests(source, { classes, races, spells }, blocks);

  return {
    lines,
    header: {
      v: REALM_FORMAT,
      // A bundled world is named after itself; a player's is named after its file.
      source: shipped?.world ?? source.path.split(/[\\/]/).pop() ?? source.path,
      rooms: placed,
      generatedAt: today,
      items,
      mobs,
      shops,
      spells,
      races,
      classes,
      ...(build === null ? {} : { build }),
      ...(family === null ? {} : { family }),
      ...(shipped === undefined ? {} : { world: shipped.world, archive: shipped.archive }),
      itemNames,
      quests
    },
    stats: {
      rooms: placed,
      withExits,
      withInstructions,
      scripted,
      levered,
      ambiguousLevers,
      openableHere,
      items: items.length,
      mobs: mobs.length,
      shops: shops.length,
      spells: spells.length,
      races: races.length,
      classes: classes.length,
      itemNames: itemNames.length,
      quests: quests.length,
      questSteps: quests.reduce((total, quest) => total + quest.steps.length, 0)
    }
  };
}

/**
 * Every shop that stocks anything, and what.
 *
 * A shop with no stock is left out rather than carried empty: the table has 283
 * rows and 175 of them sell something, and the rest are placeholders — one is
 * literally called "Leave this blank". A room pointing at one of those is a
 * room the realm data cannot say anything useful about, and an empty card
 * saying "sells nothing" is worse than no card.
 *
 * Sorted by id, like every other index here, so a realm converted at runtime
 * and one built by the script produce byte-identical output.
 */
export function indexShops(source: RealmSource): BuiltShop[] {
  const shops = source.table('Shops');
  if (shops === null) return [];

  const built: BuiltShop[] = [];
  for (const row of shops.rows) {
    const id = number(row['Number']);
    if (id === null || id <= 0) continue;

    const items: number[] = [];
    for (const [column, value] of Object.entries(row)) {
      if (!/^Item-\d+$/.test(column)) continue;
      const item = number(value);
      // Zero is the realm's empty slot, not item zero.
      if (item !== null && item > 0) items.push(item);
    }
    const kind = number(row['ShopType']);
    /*
     * A shop with nothing on its shelves is a placeholder — unless it is a
     * bank, a temple, an inn or a training room, which stock nothing and are
     * still the place they are. Those are kept for their kind alone: the
     * glyph beside `Bank of Godfrey` comes from exactly this row.
     */
    const placeOnly = kind !== null && [5, 7, 8, 9].includes(kind);
    if (items.length === 0 && !placeOnly) continue;

    const entry: BuiltShop = { id, n: text(row['Name']).trim(), items };
    const markup = number(row['Markup%']);
    if (markup !== null && markup > 0) entry.markup = markup;
    if (kind !== null && kind > 0) entry.t = kind;
    /*
     * Who this place serves and what it charges to — format 35.
     *
     * `MinLVL`/`MaxLVL` are the band a training room takes and `TrainCommand`
     * enforces both ends, so a client picking a trainer needs them or it walks
     * to the obvious room and is refused. `ClassRest` is one class id, 0 for
     * *anybody*, written only when it restricts — a zero here means the same
     * as absence and carrying it would cost a field on every shop row.
     *
     * Written for every shop rather than for trainers alone: the columns are
     * the row's whatever its type, the reading of them is the caller's, and a
     * band on a shop nobody has looked at yet is a fact the file should carry
     * rather than a question a later format has to reopen.
     */
    const minLevel = number(row['MinLVL']);
    const maxLevel = number(row['MaxLVL']);
    const classRest = number(row['ClassRest']);
    if (minLevel !== null && minLevel > 0) entry.min = minLevel;
    if (maxLevel !== null && maxLevel > 0) entry.max = maxLevel;
    if (classRest !== null && classRest > 0) entry.cls = classRest;
    built.push(entry);
  }

  return built.sort((a, b) => a.id - b.id);
}

/**
 * Every spell the realm names.
 *
 * The whole table, for the reason the monster index takes the whole table and
 * the item index does not: an exit tells you in advance which key it wants, and
 * nothing tells you in advance which spell somebody will look up.
 *
 * A row with no name is a gap in the table rather than a spell, and is skipped.
 */
export function indexSpells(source: RealmSource): BuiltSpell[] {
  const spells = source.table('Spells');
  if (spells === null) return [];

  const built: BuiltSpell[] = [];
  for (const row of spells.rows) {
    const id = number(row['Number']);
    const name = text(row['Name']).trim();
    if (id === null || name.length === 0) continue;

    const entry: BuiltSpell = { id, n: name };
    const short = text(row['Short']).trim();
    if (short.length > 0 && short.toLowerCase() !== name.toLowerCase()) entry.short = short;
    // Each omitted when the realm does not state it: zero mana is a real
    // answer for some spells, and absent is not zero.
    const level = number(row['ReqLevel']);
    if (level !== null && level > 0) entry.level = level;
    const mana = number(row['ManaCost']);
    if (mana !== null && mana > 0) entry.mana = mana;
    const energy = number(row['EnergyCost']);
    if (energy !== null && energy > 0) entry.energy = energy;
    const dur = number(row['Dur']);
    if (dur !== null && dur > 0) entry.dur = dur;
    /*
     * Who it may be cast on. Zero is the realm's *no target* answer — every
     * one of the 72 rows holding it is a monster's breath, a trap or a
     * caster-only effect — so it is left out like every other zero here and
     * read back as "the realm does not say", which keeps a picker open
     * rather than closing it on an absence.
     */
    const targets = number(row['Targets']);
    if (targets !== null && targets > 0) entry.tg = targets;
    // Format 20. Zero is the realm's *never resisted* and is left out like
    // every zero here; absent reads back as the cast that lands.
    const resists = number(row['TypeOfResists']);
    if (resists !== null && resists > 0 && resists !== BLANK_AS_NUMBER) entry.res = resists;
    /*
     * How much easier or harder this spell is than the caster's own figure —
     * format 22, and the one input to `Spell.Cast`'s roll that varies per
     * spell (`chance = min(100, SpellCasting + Diff)`).
     *
     * **Signed, and written whenever it is not zero** rather than when it is
     * positive. 167 spells state a negative power for the same reason and this
     * column has the same shape: `ethereal shield` is −5 on the Paradigm
     * database, which is a spell that is *harder* than the caster's figure
     * suggests, and dropping the sign would make it easier. Zero is the
     * realm's *neither*, left out like every other zero here and read back as
     * the spell that costs its caster nothing either way.
     */
    const difficulty = number(row['Diff']);
    if (difficulty !== null && difficulty !== 0 && difficulty !== BLANK_AS_NUMBER) {
      entry.dif = difficulty;
    }
    const ab = abilityPairs(row);
    if (ab.length > 0) entry.ab = ab;
    /*
     * The spell's own magnitude — format 16.
     *
     * Signed and kept as stated: 167 spells state a negative power, which is a
     * spell that takes something away, and clamping those to zero would turn a
     * debuff into a no-op on the card. A growth pair is written only when both
     * halves are real, because `+3 every 0 levels` is not a rate — measured on
     * the shipped realm, no row states one without the other.
     */
    const minBase = number(row['MinBase']) ?? 0;
    const maxBase = number(row['MaxBase']) ?? 0;
    if (minBase !== 0 || maxBase !== 0) entry.pw = [minBase, maxBase];
    const cap = number(row['Cap']);
    if (cap !== null && cap > 0) entry.cap = cap;
    // The element — format 34. Zero is cold, so only a blank is omitted.
    const attackType = number(row['AttType']);
    if (attackType !== null && attackType !== BLANK_AS_NUMBER) entry.at = attackType;
    for (const [levels, amount, field] of [
      ['MinIncLVLs', 'MinInc', 'mig'],
      ['MaxIncLVLs', 'MaxInc', 'mag'],
      ['DurIncLVLs', 'DurInc', 'dug']
    ] as const) {
      const per = number(row[levels]);
      const step = number(row[amount]);
      if (per !== null && per > 0 && step !== null && step !== 0) entry[field] = [per, step];
    }
    built.push(entry);
  }

  return built.sort((a, b) => a.id - b.id);
}

/**
 * A stat's `[minimum, maximum]`, or nothing.
 *
 * Both ends or neither: half a range is not a range, and a maximum drawn
 * against a missing minimum reads as a range starting at zero.
 */
function span(row: Record<string, unknown>, stat: string): [number, number] | undefined {
  const low = number(row[`m${stat}`]);
  const high = number(row[`x${stat}`]);
  if (low === null || high === null || low <= 0 || high <= 0) return undefined;
  return [low, high];
}

/**
 * The database's own account of itself — the `Info` table.
 *
 * One row of seven columns, and until format 21 `buildRealm.ts` never opened
 * it: not the family, not the data set's version, not its build date, not its
 * update URL. All of that was in the file and invisible to the client, not
 * even as a warning.
 *
 * Carried whole rather than reduced to the family, because **provenance is
 * part of the answer**: every derived number this client will grow has to be
 * able to say which build of which data set it came from, and `Custom` on the
 * shipped realm reading `Gmud 1.6 Final` beside a `Dat File Version` of
 * `v1.11p` is what makes *how does it know that* answerable.
 *
 * More than one row is not something any distribution does; the first is taken
 * and the rest ignored rather than refused, for the same reason every other
 * reader here is forgiving — a realm file is a file a player points at.
 */
export function indexBuild(source: RealmSource): RealmBuild | null {
  const info = source.table('Info');
  const row = info?.rows[0];
  if (row === undefined) return null;

  const word = (column: string): string | null => {
    const value = text(row[column]).trim();
    return value.length === 0 ? null : value;
  };

  const build: RealmBuild = {
    nmr: word('NMR Version'),
    data: word('Dat File Version'),
    date: word('Date'),
    time: word('Time'),
    custom: word('Custom'),
    legit: number(row['Legit']),
    updateUrl: word('UpdateURL')
  };
  return isEmptyBuild(build) ? null : build;
}

/**
 * Every race the realm offers.
 *
 * Thirteen rows on the shipped realm, and small enough to carry whole. Unlike
 * the monster table there is no `In Game` flag here: a race in the table is a
 * race the character-creation screen offers.
 */
export function indexRaces(source: RealmSource): BuiltRace[] {
  const races = source.table('Races');
  if (races === null) return [];

  const built: BuiltRace[] = [];
  for (const row of races.rows) {
    const id = number(row['Number']);
    const name = text(row['Name']).trim();
    if (id === null || name.length === 0) continue;

    const entry: BuiltRace = { id, n: name };
    for (const [key, stat] of [
      ['int', 'INT'],
      ['wil', 'WIL'],
      ['str', 'STR'],
      ['hea', 'HEA'],
      ['agl', 'AGL'],
      ['chm', 'CHM']
    ] as const) {
      const range = span(row, stat);
      if (range) entry[key] = range;
    }
    // Zero is "no bonus" and is left out rather than drawn as a bonus of none;
    // only the Half-Ogre states one on the shipped realm.
    const hp = number(row['HPPerLVL']);
    if (hp !== null && hp > 0) entry.hpPerLevel = hp;
    /*
     * **Any stated number is kept, including a negative one**, unlike the hit
     * points above. This is not a bonus that zero means nothing about — it is
     * one of the two terms of `100 + race + class`, which is the multiplier the
     * whole experience table is built from (`src/shared/experience.ts`). Stock
     * MajorMUD prices a Thief at **-20**, and dropping the sign there costs
     * every Thief a fifth more experience per level than the realm charges.
     * Zero is left out because zero contributes nothing to a sum.
     */
    const exp = number(row['ExpTable']);
    if (exp !== null && exp !== 0) entry.expTable = exp;
    const ab = abilityPairs(row);
    if (ab.length > 0) entry.ab = ab;
    built.push(entry);
  }

  return built.sort((a, b) => a.id - b.id);
}

/**
 * Every class the realm offers.
 *
 * Fifteen rows. See `BuiltClass` for the two columns deliberately not carried:
 * a hit-dice pair whose order nothing has settled, and a magery *type* whose
 * numbering only says something for zero.
 */
export function indexClasses(source: RealmSource): BuiltClass[] {
  const classes = source.table('Classes');
  if (classes === null) return [];

  const built: BuiltClass[] = [];
  for (const row of classes.rows) {
    const id = number(row['Number']);
    const name = text(row['Name']).trim();
    if (id === null || name.length === 0) continue;

    const entry: BuiltClass = { id, n: name };
    // Negative is a real price and zero is not; see `indexRaces`.
    const exp = number(row['ExpTable']);
    if (exp !== null && exp !== 0) entry.expTable = exp;
    // A class with no magery states level 0, which is an absence rather than a
    // level: a Warrior drawn as "magery 0" reads as a caster with none left.
    const magery = number(row['MageryLVL']);
    if (magery !== null && magery > 0) entry.magery = magery;
    const combat = number(row['CombatLVL']);
    if (combat !== null && combat > 0) entry.combat = combat;
    const ab = abilityPairs(row);
    if (ab.length > 0) entry.ab = ab;
    built.push(entry);
  }

  return built.sort((a, b) => a.id - b.id);
}

/**
 * Every monster the realm has, by name, with the health it is worth.
 *
 * The whole table rather than the referenced subset the item index takes, and
 * deliberately: an item index only needs the hundred-odd keys some exit asks
 * for, while *any* monster in the realm can walk into the room and start
 * hitting somebody. About 1,800 rows collapse to roughly 1,450 names and a few
 * tens of kilobytes before compression, which is a fair price for the one
 * number a fight is judged on.
 *
 * **Rows the realm has switched off are left out.** `In Game` is the realm
 * builder's own flag for content that exists in the table and not in the world;
 * including it would let a retired monster's health widen the range of a name a
 * live one shares, and the widening is invisible from the outside.
 *
 * Sorted by name so a realm converted at runtime and one built by the script
 * produce byte-identical output.
 */
export function indexMobs(source: RealmSource, itemNames?: Map<number, string>): BuiltMob[] {
  const monsters = source.table('Monsters');
  if (monsters === null) return [];

  /**
   * The worst of the rows sharing a name, for a column where "worst" is
   * *higher*.
   *
   * The health span's rule applied to every number added in format 12: a name
   * resolves to several rows, and the reassuring end of a range is the
   * dangerous one to act on. `8224` is refused along the way — it is two ASCII
   * spaces in a numeric column, which `mdb-reader` surfaces as an integer, and
   * it appears on 348 rows of the shipped realm's `Items.Speed` alone.
   */
  const worse = (held: number | undefined, value: number | null): number | undefined => {
    if (value === null || value <= 0 || value === BLANK_AS_NUMBER) return held;
    return held === undefined || value > held ? value : held;
  };
  /** And for a column where the cautious answer is *lower* — what it is worth. */
  const least = (held: number | undefined, value: number | null): number | undefined => {
    if (value === null || value <= 0 || value === BLANK_AS_NUMBER) return held;
    return held === undefined || value < held ? value : held;
  };

  const spans = new Map<
    string,
    {
      lo: number;
      hi: number;
      how: Set<MobDisposition>;
      costs: boolean[];
      ids: number[];
      ac?: number;
      dr?: number;
      mr?: number;
      xp?: number;
      rgn?: number;
      fol?: number;
      und?: 1;
      /**
       * Format 36: every clock the rows state, a row stating none counted as
       * `0` so that silence is a voice. Gathered rather than reduced for the
       * reason `BuiltMob.rt` gives — one value means the name agrees.
       */
      rts: Set<number>;
      /** Format 18: gathered rather than reduced, for the reason `ty` states. */
      types: Set<number>;
      dmg?: number;
      chl?: number;
      /** Every spell any row casts mid-fight, and every death spell. */
      casts: Set<number>;
      deathSpell?: number;
      /** Format 20: each distinct row profile, keyed on its own JSON. */
      profiles: Map<string, MobProfile>;
      /**
       * Format 32: every row that has a number, in `ids` order, answering for
       * itself — its profile's index in `profiles` and its own columns, folded
       * with nothing. See `BuiltMobRow`.
       */
      rows: BuiltMobRow[];
      drops: Set<string>;
      /**
       * Ability id → every value the rows sharing this name state for it.
       *
       * A **set**, not the maximum, because "worst" only means "highest" for a
       * magnitude. See the fold below.
       */
      abil: Map<number, Set<number>>;
    }
  >();
  for (const row of monsters.rows) {
    // Absent column and present-but-zero are both "this realm does not say",
    // and neither may become a maximum of zero — a bar against zero is a
    // division nobody can read.
    const hp = number(row['HP']);
    if (hp === null || hp <= 0) continue;
    // `In Game` is 0/1 in every export seen; a realm without the column at all
    // is taken at face value rather than emptied.
    if ('In Game' in row && number(row['In Game']) === 0) continue;

    const name = text(row['Name']).trim().toLowerCase();
    if (name.length === 0) continue;

    /*
     * Whether it starts the fight, from the two columns the server reads.
     *
     * Spelled `Align` in the `.mdb` every derivative distributes and
     * `Alignment` in the extraction the GreaterMUD server itself loads, which
     * is the same drift `In Game` has — so both are accepted rather than one
     * of them producing a realm whose monsters are all silently peaceable.
     * A realm stating neither column contributes nothing, and the name is
     * written without a disposition rather than with a made-up one.
     */
    const align = number(row['Align'] ?? row['Alignment']);
    const kind = number(row['Type']);

    const span = spans.get(name);
    const how = span?.how ?? new Set<MobDisposition>();
    const rowHow = align === null ? null : dispositionOf(align, kind ?? 0);
    if (rowHow !== null) how.add(rowHow);
    /*
     * Every row's answer is kept rather than folded to a single flag, because
     * *all of them* and *some of them* are different facts and the difference
     * is what keeps the refusal from swallowing the first monster anybody
     * meets. `giant rat` is two ChaoticEvil rows and one Good one.
     */
    const costs = span?.costs ?? [];
    if (align !== null) costs.push(costsAlignment(align));

    const id = number(row['Number']);
    const entry = span ?? {
      lo: hp,
      hi: hp,
      how,
      costs,
      ids: id === null ? [] : [id],
      rts: new Set<number>(),
      types: new Set<number>(),
      casts: new Set<number>(),
      profiles: new Map<string, MobProfile>(),
      rows: [],
      drops: new Set<string>(),
      abil: new Map<number, Set<number>>()
    };
    if (span) {
      if (id !== null) entry.ids.push(id);
      if (hp < entry.lo) entry.lo = hp;
      if (hp > entry.hi) entry.hi = hp;
    }

    /*
     * Format 12. Every one of these is optional in the realm data and several
     * derivatives omit whole columns, so each is folded through `worse`/`least`
     * rather than read — a column this realm does not have contributes nothing
     * instead of contributing a zero.
     */
    entry.ac = worse(entry.ac, number(row['ArmourClass']));
    entry.dr = worse(entry.dr, number(row['DamageResist']));
    entry.mr = worse(entry.mr, number(row['MagicRes']));
    entry.xp = least(entry.xp, number(row['EXP']));
    entry.rgn = worse(entry.rgn, number(row['HPRegen']));
    entry.fol = worse(entry.fol, number(row['Follow%']));
    if (number(row['Undead']) === 1) entry.und = 1;
    /*
     * Format 36. Not folded through `worse`: a clock is not a magnitude, and a
     * row that states none is on the room's own clock rather than absent from
     * the question — so it votes `0` and a disagreeing name states nothing.
     */
    entry.rts.add(ownClock(row) ?? 0);
    /*
     * Format 18. `ty` is gathered because nothing reduces it — see the field.
     * `dmg` takes the worst, like `ac` and `dr`; `chl` takes the worst too,
     * which here is the *highest* level required to charm it. The spells are
     * gathered: a name that resolves to several rows may have one row that
     * detonates on death, and that is the row an automation must decline.
     */
    const kindOf = number(row['Type']);
    if (kindOf !== null) entry.types.add(kindOf);
    entry.dmg = worse(entry.dmg, number(row['AvgDmg']));
    entry.chl = worse(entry.chl, number(row['CharmLVL']));
    for (let slot = 0; slot < MID_SPELL_SLOTS; slot += 1) {
      const cast = number(row[`MidSpell-${slot}`]);
      if (cast !== null && cast > 0) entry.casts.add(cast);
    }
    const onDeath = number(row['DeathSpell']);
    if (onDeath !== null && onDeath > 0) entry.deathSpell = onDeath;
    /*
     * Format 20: how this row fights, kept per row and de-duplicated on its
     * own JSON so four identical `barmaid` rows are one profile. The insertion
     * order is the rows' order, which is what keeps two builds byte-identical.
     */
    const profile = rowProfile(row);
    let which = -1;
    if (profile !== null) {
      const key = JSON.stringify(profile);
      if (!entry.profiles.has(key)) entry.profiles.set(key, profile);
      which = [...entry.profiles.keys()].indexOf(key);
    }
    /*
     * Format 32: this row's own answers, kept in step with `ids` so a lair —
     * or a name resolved to a row by the room it is standing in — is weighed
     * by the row rather than by the worst of its twins. Read straight off the
     * columns rather than through `worse`/`least`, which fold across rows and
     * have nothing to fold here.
     */
    if (id !== null) {
      const own: BuiltMobRow = { hp };
      if (which >= 0) own.p = which;
      if (rowHow !== null) own.d = DISPOSITION_CODE[rowHow];
      const stated = (column: string): number | undefined => {
        const value = number(row[column]);
        return value === null || value <= 0 || value === BLANK_AS_NUMBER ? undefined : value;
      };
      own.ac = stated('ArmourClass');
      own.dr = stated('DamageResist');
      own.mr = stated('MagicRes');
      own.xp = stated('EXP');
      own.rgn = stated('HPRegen');
      // Only where `GameLimit` makes it one — see `ownClock`.
      own.rt = ownClock(row) ?? undefined;
      own.fol = stated('Follow%');
      own.dmg = stated('AvgDmg');
      own.chl = stated('CharmLVL');
      if (number(row['Undead']) === 1) own.und = 1;
      entry.rows.push(own);
    }
    /*
     * The effect system — format 14. Every value every row states, gathered
     * here and reduced per id below, because how to reduce depends on the id.
     *
     * 100 of the 234 names shared by several rows disagree about their effects
     * (measured against `gmud20230902`, 2026-08-31): a `zombie` is three rows,
     * one of them 100% cold-resistant and another not.
     */
    for (const [which, value] of abilityPairs(row)) {
      const held = entry.abil.get(which);
      if (held === undefined) entry.abil.set(which, new Set([value]));
      else held.add(value);
    }
    /*
     * Its drop table, by name. The item numbers are useless to a reader and the
     * item index does not carry every item, so a drop whose name nothing knows
     * is left out rather than written as a number.
     */
    if (itemNames !== undefined) {
      for (const [column, value] of Object.entries(row)) {
        if (!/^DropItem-\d+$/.test(column)) continue;
        const dropped = number(value);
        if (dropped === null || dropped <= 0) continue;
        const named = itemNames.get(dropped);
        if (named !== undefined && named.length > 0) entry.drops.add(named);
      }
    }

    if (!span) spans.set(name, entry);
  }

  return [...spans.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([n, span]) => {
      const mob: BuiltMob = { n, hp: span.lo };
      if (span.ids.length > 0) mob.i = span.ids;
      if (span.hi > span.lo) mob.hi = span.hi;
      if (span.how.size > 0) mob.d = DISPOSITION_CODE[worstDisposition(span.how)];
      // 21 of 1,514 names in the shipped realm, `giant rat` among them. The
      // flag is what stops the worst case being acted on as though it were the
      // answer; see `WorldMob.uncertain`.
      if (span.how.size > 1) mob.x = 1;
      const cost = alignmentCost(span.costs);
      if (cost !== 'never') mob.ep = cost === 'always' ? 'a' : 's';
      // Format 12, each omitted where the realm said nothing.
      if (span.ac !== undefined) mob.ac = span.ac;
      if (span.dr !== undefined) mob.dr = span.dr;
      if (span.mr !== undefined) mob.mr = span.mr;
      if (span.xp !== undefined) mob.xp = span.xp;
      if (span.rgn !== undefined) mob.rgn = span.rgn;
      if (span.fol !== undefined) mob.fol = span.fol;
      if (span.und !== undefined) mob.und = span.und;
      // Format 36. One value is the whole name agreeing; `0` is every row
      // saying *on the room's clock*, which is not a clock of its own.
      if (span.rts.size === 1) {
        const only = [...span.rts][0]!;
        if (only > 0) mob.rt = only;
      }
      // Format 18. Sorted so a file written twice from one database matches.
      if (span.types.size > 0) mob.ty = [...span.types].sort((a, b) => a - b);
      if (span.dmg !== undefined) mob.dmg = span.dmg;
      if (span.chl !== undefined) mob.chl = span.chl;
      if (span.casts.size > 0) mob.cast = [...span.casts].sort((a, b) => a - b);
      if (span.deathSpell !== undefined) mob.ds = span.deathSpell;
      // Format 20. Row order, not sorted: a profile has no natural key and
      // the rows' order is the one order every build of one database shares.
      if (span.profiles.size > 0) mob.pf = [...span.profiles.values()].map(compactProfile);
      /*
       * Format 32. Only where the rows can be told apart at all: with one row
       * the fold *is* the row, and a realm whose rows carry no number has
       * nothing for a lair or a room to name. Kept in step with `i` or not
       * written at all — a reader indexes one by the other, and a list one
       * short would answer for the row beside the one asked about.
       */
      if (span.ids.length > 1 && span.rows.length === span.ids.length) mob.rw = span.rows;
      // Capped and sorted: "one of these six" is a lead, a list of forty is
      // not, and a stable order is what keeps two builds byte-identical.
      if (span.drops.size > 0) mob.drops = [...span.drops].sort().slice(0, 6);
      /*
       * **Every distinct value every row states**, and no reduction here.
       *
       * The first attempt folded to the maximum, on the reading that the worst
       * of the rows is the highest — which is right for a magnitude and wrong
       * for the two shapes whose value is a *row id*. `SpellImmu 40` and
       * `SpellImmu 45` on the two `ancient sand dragon` rows are two different
       * spells, not a bigger number, and `dwarven warrior` row 446 states
       * `MonsGuards` twice in one row (424 and 426): a maximum silently drops
       * one of them.
       *
       * Deciding per id would mean reading `ABILITY_SHAPE` here, and that is
       * exactly the display judgement this file refuses to make — see the note
       * on `BuiltItem.ab`. A shape is a claim from another client's source and
       * may be corrected; baking one into the file every future card reads
       * would make the correction unreachable without a rebuild.
       *
       * So the realm's own answer is written whole, one pair per distinct
       * value — which is the shape `EffectRows` already collects by id, the
       * same way `ClassOk` lists several classes. It costs 178 extra pairs
       * across the whole realm (measured 2026-08-31), and the card decides how
       * to read them: the *high* end of a magnitude, every one of a reference.
       *
       * Sorted throughout rather than kept in the realm's slot order, because
       * the fold is across rows and "the order" is no longer any one row's. A
       * stable order is what keeps a realm converted at runtime byte-identical
       * to one built by the script.
       */
      if (span.abil.size > 0) {
        const pairs: Array<[number, number]> = [];
        for (const [which, values] of [...span.abil.entries()].sort(([a], [b]) => a - b)) {
          for (const value of [...values].sort((a, b) => a - b)) pairs.push([which, value]);
        }
        mob.ab = pairs;
      }
      return mob;
    });
}

/**
 * Every item name the realm has, lower-cased and sorted.
 *
 * The recognition half of the item table, kept apart from `indexItems`'s
 * detail half — see `BuiltRealm.header.itemNames` for why the two are not one
 * list. A row with no name is a gap in the table rather than an item.
 */
export function indexItemNames(source: RealmSource): string[] {
  const items = source.table('Items');
  if (items === null) return [];

  const names = new Set<string>();
  for (const row of items.rows) {
    const name = text(row['Name']).trim().toLowerCase();
    if (name.length > 0) names.add(name);
  }
  // Sorted so a realm converted at runtime and one built by the script produce
  // byte-identical output, as every other index here is.
  return [...names].sort();
}

/**
 * Which items somebody could actually be holding, and where a player might get
 * one.
 *
 * A locked door says `Key: 1124`, which tells nobody anything. The index is
 * kept to the items something in the realm refers to — an exit's key, a shop's
 * stock, a monster's drop list, a script's `giveitem` — so this costs a few
 * tens of kilobytes rather than carrying the whole item table.
 *
 * Provenance is best-effort and says so. Roughly half of these keys are dropped
 * by a monster and a handful are sold in a shop; the rest are not answerable
 * from this database at all, and an entry with neither is more honest than a
 * guess. `from` is the third answer and the only one that is not a column —
 * see `itemsInReach`.
 */
export function indexItems(
  source: RealmSource,
  needed: Set<number>,
  from: Map<number, BuiltItemFrom[]> = new Map(),
  lands: Map<number, ItemLanding> = new Map()
): BuiltItem[] {
  if (needed.size === 0) return [];

  const rowsOf = (name: string): Record<string, unknown>[] => source.table(name)?.rows ?? [];

  const names = new Map<number, string>();
  const prices = new Map<number, number>();
  const currencies = new Map<number, number>();
  const weights = new Map<number, number>();
  /** Format 18: `Gettable`, `Not Droppable` and `Limit`, only where notable. */
  const flags = new Map<number, { ngt?: 1; ndr?: 1; lim?: number }>();
  const abilities = new Map<number, Array<[number, number]>>();
  /** Who the realm lets use a thing — `ClassRest-n` / `RaceRest-n`, format 15. */
  const restrictions = new Map<number, Pick<BuiltItem, 'cls' | 'race'>>();
  /** Everything about an item that depends on what kind of thing it is. */
  const kinds = new Map<number, Pick<BuiltItem, 'type' | 'worn' | 'wpn' | 'arm' | 'uses'>>();
  /** A column's value when it is a positive number, else undefined. */
  const positive = (row: Record<string, unknown>, column: string): number | undefined => {
    const value = number(row[column]);
    return value !== null && value > 0 ? value : undefined;
  };
  for (const item of rowsOf('Items')) {
    const id = number(item['Number']);
    if (id === null || !needed.has(id)) continue;
    names.set(id, text(item['Name']));
    const price = number(item['Price']);
    if (price !== null && price > 0) prices.set(id, price);
    const currency = number(item['Currency']);
    if (price !== null && price > 0 && currency !== null && currency > 0) {
      currencies.set(id, currency);
    }
    const encumbrance = number(item['Encum']);
    if (encumbrance !== null && encumbrance > 0) weights.set(id, encumbrance);
    /*
     * Format 18: the two refusals and the cap.
     *
     * Only the refusals are written. 2,594 of the shipped realm's 2,639 items
     * are gettable, so recording the ordinary answer costs a byte per item to
     * say nothing — and absent must read as *gettable*, because on a
     * derivative realm without the column the alternative is an automation
     * that quietly stops looting everything.
     */
    if (number(item['Gettable']) === 0) flags.set(id, { ...flags.get(id), ngt: 1 });
    if (number(item['Not Droppable']) === 1) flags.set(id, { ...flags.get(id), ndr: 1 });
    const limit = number(item['Limit']);
    if (limit !== null && limit > 0) flags.set(id, { ...flags.get(id), lim: limit });

    /*
     * Who may use it — `ClassRest-0..9` and `RaceRest-0..9`, format 15.
     *
     * Read **before** the kind gate below, which is a `continue`: a derivative
     * realm without `ItemType` would otherwise restrict nothing, and an item
     * whose restrictions the client cannot see is one it offers a button for
     * and the server refuses out loud. Same reason the ability pairs moved
     * above that gate.
     *
     * An allow-list where it is stated at all, and zero is the empty slot —
     * exactly like `Abil-n`. Sorted so a file written twice from the same
     * database is the same file.
     */
    const restrictedTo = (prefix: string): number[] | undefined => {
      const found = new Set<number>();
      for (let slot = 0; slot < RESTRICTION_SLOTS; slot += 1) {
        const which = positive(item, `${prefix}-${slot}`);
        if (which !== undefined) found.add(which);
      }
      return found.size > 0 ? [...found].sort((a, b) => a - b) : undefined;
    };
    const cls = restrictedTo('ClassRest');
    const race = restrictedTo('RaceRest');
    if (cls !== undefined || race !== undefined) {
      restrictions.set(id, { ...(cls ? { cls } : {}), ...(race ? { race } : {}) });
    }

    /*
     * What it does — read **before** the kind, because the kind gate below is a
     * `continue`.
     *
     * The effect pairs used to be read after it, so an item on a derivative
     * whose `Items` table lacks `ItemType` was written with no effects at all,
     * silently. The read side had the identical bug in `WorldGraph` and was
     * fixed in the same change; a fix on only one side leaves a realm whose
     * effects were never *written*, which no reader can recover.
     */
    const pairs = abilityPairs(item);
    if (pairs.length > 0) abilities.set(id, pairs);

    /*
     * The kind decides which of the other columns mean anything: `Min`/`Max`
     * are a weapon's and read as zero on a helm; `ArmourClass` is armour's and
     * reads as zero on a sword. Reading them all for every item would carry
     * six zeros per row and invite a card to print them. `ItemType` is a
     * column a derivative may lack, in which case nothing here is claimed.
     */
    const type = number(item['ItemType']);
    if (type === null) continue;
    const kind: Pick<BuiltItem, 'type' | 'worn' | 'wpn' | 'arm' | 'uses'> = { type };
    const worn = positive(item, 'Worn');
    if (worn !== undefined) kind.worn = worn;
    // Any non-zero count, so the realm's `-1` (unlimited) survives; see
    // `BuiltItem.uses` for what dropping it cost.
    const uses = number(item['UseCount']);
    if (uses !== null && uses !== 0) kind.uses = uses;
    if (itemKind(type) === 'weapon') {
      const min = number(item['Min']) ?? 0;
      const max = number(item['Max']) ?? 0;
      const wpn: NonNullable<BuiltItem['wpn']> = { min, max };
      const spd = positive(item, 'Speed');
      if (spd !== undefined) wpn.spd = spd;
      const str = positive(item, 'StrReq');
      if (str !== undefined) wpn.str = str;
      const acc = positive(item, 'Accy');
      if (acc !== undefined) wpn.acc = acc;
      const weaponType = number(item['WeaponType']);
      if (weaponType !== null) wpn.kind = weaponType;
      kind.wpn = wpn;
    } else if (itemKind(type) === 'armour') {
      const arm: NonNullable<BuiltItem['arm']> = {};
      const ac = positive(item, 'ArmourClass');
      if (ac !== undefined) arm.ac = ac;
      const dr = positive(item, 'DamageResist');
      if (dr !== undefined) arm.dr = dr;
      const armourType = number(item['ArmourType']);
      if (armourType !== null) arm.kind = armourType;
      kind.arm = arm;
    }
    kinds.set(id, kind);

    /*
     * The effect system — format 12. Twenty slots, `Abil-n` naming what and
     * `AbilVal-n` how much, and `0` is the empty slot rather than ability zero.
     * Read in slot order and kept verbatim; `shared/abilities.ts` names them at
     * the point of display, because the *reading* is a claim from another
     * client's source and the number is what the realm said.
     */
  }

  const collect = (
    rows: Record<string, unknown>[],
    columnPattern: RegExp
  ): Map<number, Set<string>> => {
    const found = new Map<number, Set<string>>();
    for (const row of rows) {
      for (const [column, value] of Object.entries(row)) {
        if (!columnPattern.test(column)) continue;
        const id = number(value);
        if (id === null || !needed.has(id)) continue;
        if (!found.has(id)) found.set(id, new Set());
        found.get(id)!.add(text(row['Name']));
      }
    }
    return found;
  };

  const soldBy = collect(rowsOf('Shops'), /^Item-\d+$/);
  const droppedBy = collect(rowsOf('Monsters'), /^DropItem-\d+$/);

  return [...needed]
    .sort((a, b) => a - b)
    .map((id) => {
      const entry: BuiltItem = { id, n: names.get(id) ?? '' };
      const price = prices.get(id);
      if (price !== undefined) entry.price = price;
      const currency = currencies.get(id);
      if (currency !== undefined) entry.cur = currency;
      const weight = weights.get(id);
      if (weight !== undefined) entry.enc = weight;
      const flag = flags.get(id);
      if (flag?.ngt !== undefined) entry.ngt = flag.ngt;
      if (flag?.ndr !== undefined) entry.ndr = flag.ndr;
      if (flag?.lim !== undefined) entry.lim = flag.lim;
      // Capped: "one of these six" is a lead; a list of forty is not.
      const sold = [...(soldBy.get(id) ?? [])].filter(Boolean).slice(0, 6);
      const dropped = [...(droppedBy.get(id) ?? [])].filter(Boolean).slice(0, 6);
      if (sold.length > 0) entry.shops = sold;
      if (dropped.length > 0) entry.mobs = dropped;
      // Capped on the same rule and for the same reason as the two above.
      const scripts = from.get(id)?.slice(0, 6) ?? [];
      if (scripts.length > 0) entry.from = scripts;
      // Where using it puts you, and where it may be used — formats 40 and
      // 41. See `landingsOfItems`.
      const landing = lands.get(id);
      if (landing !== undefined) {
        entry.lands = landing.to;
        if (landing.usableIn !== undefined) entry.landsFrom = [...landing.usableIn];
      }
      const effects = abilities.get(id);
      if (effects !== undefined) entry.ab = effects;
      /*
       * The level gate, lifted out of the pairs into a field of its own.
       *
       * It stays in `ab` as well — that array is what the realm said and the
       * Reference card draws it from there — but a *gate* every equip check
       * consults must not make each caller re-scan an untyped pair list for
       * one id. `MinLevel` is ability 135; the realm states it on 953 items.
       */
      const gate = effects?.find(([which]) => which === MIN_LEVEL_ABILITY);
      if (gate !== undefined && gate[1] > 0) entry.lvl = gate[1];
      return { ...entry, ...restrictions.get(id), ...kinds.get(id) };
    });
}
