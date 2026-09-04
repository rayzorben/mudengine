/**
 * Plays a character for a while, through the client's own session layer, and
 * writes down everything it could not read and everything it decided.
 *
 * Not a measurement of one thing, like the other probes: this is the
 * "iterate and play" loop. The character logs in with automation on — combat,
 * loot, resting — walks to a hunting ground, fights what comes, retreats and
 * rests when hurt, spends its coins in the nearest shop on something it can
 * wear, asks the guild to train when the experience is there, and looks in the
 * realm data for a lair within its range when the arena has been done to
 * death. Every line is streamed to a JSONL log as it happens so the run can be
 * analysed while it is still going.
 *
 *   PLAY_MS=1200000 npm run probe:play
 */
import fs from 'node:fs';
import path from 'node:path';

import { SessionManager } from '../src/main/session/SessionManager.ts';
import { FightLog } from '../src/main/session/FightLog.ts';
import { RealmLibrary } from '../src/main/world/RealmLibrary.ts';
import { commandOf } from '../src/shared/commands.ts';
import { HOST, PORT, configPath, localProfile, skip, target } from './lib/local-realm.mjs';
import { OPPOSITE } from '../src/shared/world.ts';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const PLAY_MS = Number(process.env.PLAY_MS ?? 1_200_000);
const HUNT = 'Newhaven, Arena';
const ROAD = 'Newhaven, Narrow Road';
// Not the road: the arena's monsters wander up onto it, and a rest there is
// rest, attack, fight, rest all evening. One room further is quiet.
const REST = 'Newhaven, Narrow Path';
const GUILD = "Newhaven, Adventurer's Guild";
const RETREAT_BELOW = 0.35;
const RESUME_ABOVE = 0.85;
const OUT = path.resolve('out/play-probe.jsonl');

const profile = localProfile();
if (!profile) skip(`no character on ${HOST}:${PORT} with credentials.`);

// The log first: the realm library says things while it loads.
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const out = fs.createWriteStream(OUT, { flags: 'w' });
function log(kind, text, extra = {}) {
  out.write(`${JSON.stringify({ t: Date.now(), kind, text, ...extra })}\n`);
  if (kind !== 'line') console.log(`   [${kind}] ${text}`);
}

const library = new RealmLibrary({
  shippedFile: path.resolve('resources/world/rooms.jsonl.gz'),
  cacheDir: path.join(path.dirname(configPath()), 'realms'),
  notify: (message) => log('realm', message)
});
const world = library.load(profile.database).graph;
const fights = new FightLog(
  path.join(path.dirname(configPath()), 'fights', `${profile.id}.jsonl.gz`),
  { notice: (message) => log('fights', message) }
);


const blocksBySeq = new Map();
/**
 * Everything a counter has said this character cannot use, for the whole run.
 *
 * Names, lower-cased, from two sources that say the same thing a command
 * apart: the listing's `(You can't use)` note, and the server refusing to
 * equip what was bought anyway.
 */
const unusable = new Set();
/*
 * Whether there was anything to fight, which is the question a run that gains
 * no experience has to answer. "Nothing was killed" has two very different
 * causes — a realm with nothing in it, and a client that would not swing —
 * and a run that does not say which of them happened is not a measurement.
 */
const MONSTER_BLOCKS = new Set(['mob-arrives-room', 'mob-hits', 'mob-misses']);
const BLOW_BLOCKS = new Set(['user-hits', 'user-misses', 'mob-hits', 'mob-misses']);
let sawMonster = 0;
let blows = 0;
/** Unnamed `You may not wear that item!` refusals, attributed by the caller. */
let equipRefusals = 0;
let phaseNote = '(connect)';
let lastState = null;
let lastListing = null;
const recent = [];
let linesSeen = 0;
/** Whether a line matching `pattern` arrived after the `mark`th line. */
const sawSince = (mark, pattern) => recent.slice(Math.max(0, recent.length - (linesSeen - mark))).some((t) => pattern.test(t));
const session = new SessionManager(
  {
    data: () => {},
    line: (line) => {
      const text = line.plain.replace(/\s+$/, '');
      if (text.trim().length === 0) return;
      recent.push(text);
      if (recent.length > 200) recent.shift();
      linesSeen += 1;
      // Written a tick later so the block for this line has been classified.
      setTimeout(() => {
        const types = (blocksBySeq.get(line.seq) ?? []).filter((t) => t !== 'unknown');
        log('line', text, { after: phaseNote, types });
      }, 0);
    },
    block: (block) => {
      const types = blocksBySeq.get(block.seq) ?? [];
      types.push(block.type);
      blocksBySeq.set(block.seq, types);
      // The counter's own listing, with the notes the realm data cannot know.
      if (block.type === 'shop-list' && 'rows' in block) {
        lastListing = block.rows;
        /*
         * `(You can't use)` is the counter's judgment for *this* character's
         * class and race, and the realm file cannot hold it — so it is
         * remembered for the whole run rather than for one visit. The first
         * pass walked between six shops with 271,839 copper and fired
         * `user-equipped-failed` twelve times, because every counter was read
         * fresh and the same unusable item was bought again at the next one.
         */
        for (const row of block.rows) if (row.note) unusable.add(row.item.toLowerCase());
      }
      /*
       * And the other half: the server refusing to put something on.
       *
       * `You may not wear that item!` is the class-or-race refusal and it
       * **names nothing**, so the only record of what it refused is the
       * command that provoked it — counted here and attributed by the shop
       * loop, which knows what it just sent. The other two shapes of this
       * block carry an item and mean something else entirely (`already
       * wearing`, `none left unequipped`), so they must not be read as
       * unusable.
       */
      if (block.type === 'user-equipped-failed' && block.groups?.['item'] === undefined) {
        equipRefusals += 1;
      }
      if (MONSTER_BLOCKS.has(block.type)) sawMonster += 1;
      if (BLOW_BLOCKS.has(block.type)) blows += 1;
    },
    character: (state) => {
      lastState = state;
    },
    command: (command, origin) => log('sent', command, { origin }),
    state: () => {},
    telnet: () => {},
    notice: (message) => log('notice', message),
    automation: (snapshot) => {
      if (snapshot?.safety?.length) log('safety', JSON.stringify(snapshot.safety.at(-1)));
    }
  },
  world,
  {
    ...profile.config.automation,
    enabled: true,
    idle: { ...profile.config.automation.idle, enabled: false },
    loot: { coins: true, items: [] },
    health: { restBelow: 0.5, meditateBelow: 0 }
  },
  profile.config.connection.login,
  undefined,
  undefined,
  fights
);
session.resize({ cols: 80, rows: 24 });

async function say(command, settle = 1500) {
  const word = command.split(/\s+/)[0] ?? '';
  if (command !== '' && commandOf(word) === null) {
    log('refused', `not in the command table: ${command}`);
    return;
  }
  phaseNote = command === '' ? '<enter>' : command;
  session.send(`${command}\r`);
  await wait(settle);
}

const me = () => session.character;
const health = () => {
  const { hp, hpMax } = me().vitals;
  return hp !== null && hpMax ? hp / hpMax : null;
};
const hereId = () => {
  const { map, number } = me().room;
  return map === null || number === null ? null : `${map}/${number}`;
};
const hereName = () => me().room.name ?? '';

async function walkTo(name, limit = 40) {
  let from = hereId();
  if (from === null) {
    // Not yet placed — the entry probe's `rm` may still be in flight, or the
    // room was never resolved. Ask once more and wait for the answer.
    await say('rm', 2500);
    from = hereId();
  }
  const destination = world.findByName(name)[0];
  if (from === null || destination === undefined) return `no route to ${name}`;
  const route = world.route(from, `${destination.map}/${destination.room}`);
  if (route.blocked) return route.reason ?? `no route to ${name}`;
  if (route.steps.length > limit) return `${name} is ${route.steps.length} steps away`;
  // Sneak first: a Missionary can, and whether the realm agrees is the point.
  await say('sn', 1200);
  for (const step of route.steps) {
    // A door on the way is opened first; a locked one is bashed — the realm
    // data marks the arena's `Door [any picklocks/strength]` — and anything
    // else gated is not walked.
    if (step.requirement?.kind === 'door') {
      const before = linesSeen;
      await say(`open ${step.direction}`, 1200);
      if (sawSince(before, /^The (?:door|gate) is locked\./)) {
        await say(`bash ${step.direction}`, 2500);
        await say(`bash ${step.direction}`, 2500);
      }
    }
    else if (step.requirement && !passable(step.requirement)) {
      return `${step.name} is gated (${step.requirement.raw})`;
    }
    await say(step.command, 1600);
    if (me().inCombat) {
      // Something met on the way. Let auto-combat finish it, then carry on.
      await untilOutOfCombat(60_000);
    }
    if (hereName().toLowerCase() !== step.name.toLowerCase()) {
      /*
       * TEST REALM ONLY. `sys go` is the operator's teleport; ordinary
       * players on any real realm have no `sys` at all, and nothing in `src/`
       * may depend on it (docs/game-behaviour.md). Here it is the difference
       * between a run that continues and one stuck behind a door the
       * character cannot force — and only when asked for with PLAY_SYS=1.
       */
      if (process.env.PLAY_SYS === '1') {
        const [map, room] = step.to.split('/');
        log('phase', `TEST REALM ONLY: sys go ${map} ${room} past ${step.name}`);
        await say(`sys go ${map} ${room}`, 2500);
        if (hereName().toLowerCase() === step.name.toLowerCase()) continue;
      }
      return `expected ${step.name}, arrived in ${hereName() || 'nowhere the data knows'}`;
    }
  }
  return null;
}

async function untilOutOfCombat(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until && me().inCombat) await wait(500);
}

async function restUntilWell() {
  log('phase', `resting at ${Math.round((health() ?? 0) * 100)}%`);
  const until = Date.now() + 240_000;
  while (Date.now() < until) {
    await wait(3000);
    const h = health();
    if (h !== null && h >= RESUME_ABOVE) break;
    if (me().inCombat) await untilOutOfCombat(60_000);
  }
  log('phase', `rested to ${Math.round((health() ?? 0) * 100)}%`);
}

/**
 * Buy something to wear or wield, once, at the nearest shop that stocks one.
 *
 * The realm's shop prices are in *gold* (`2` is `2 gold crowns`, which the
 * counter charges 208 copper for), and the first pass compared them to wealth
 * in copper and bought scrolls a Mystic cannot even wear. So: armour or a
 * weapon by the realm's own item kind, not already carried, priced in copper
 * with the counter's markup allowed for, and `wear` rather than `arm` for
 * armour.
 */
async function shop() {
  const wealth = me().inventory.wealth ?? 0;
  const from = hereId();
  if (from === null) return false;
  const carried = new Set(me().inventory.items.map((item) => item.name.toLowerCase()));
  const wanted = (room) => {
    if (room.shop === undefined) return false;
    return (world.shop(room.shop)?.items ?? []).some((item) => affordable(item));
  };
  const affordable = (item) => {
    if (carried.has(item.name.toLowerCase())) return false;
    // Refused once is refused for the rest of the run, whichever counter says so.
    if (unusable.has(item.name.toLowerCase())) return false;
    const info = world.itemsNamed([item.name])[item.name];
    const kind = info?.kind;
    if (kind !== 'armour' && kind !== 'weapon') return false;
    const copper = item.price === undefined ? 0 : Math.ceil(item.price * 100 * 1.05);
    return copper <= wealth;
  };
  const visited = new Set();
  let bought = false;
  // Every stocked shop within reach in turn: a naked character wants the
  // armourer *and* the weaponsmith, and the nearest is the spell shop.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const here = hereId();
    if (here === null) break;
    const route = world.nearest(here, (room) => !visited.has(`${room.map}/${room.room}`) && wanted(room), 20, passable);
    if (!route || route.steps.length === 0) {
      log('phase', `nothing left to buy within reach for ${wealth} copper`);
      break;
    }
    const there = world.byId(route.steps.at(-1).to);
    visited.add(route.steps.at(-1).to);
    log('phase', `shopping: ${wealth} copper, walking ${route.steps.length} steps to ${there.name}`);
    const back = [];
    for (const step of route.steps) {
      if (step.requirement?.kind === 'door') await say(`open ${step.direction}`, 1200);
      await say(step.command, 1200);
      back.unshift(OPPOSITE[step.command] ?? null);
    }
    lastListing = null;
    await say('list', 2500);
    /*
     * The counter's listing outranks the realm data: `(You can't use)` and
     * `(Too powerful)` are things only the shop says, and the first pass
     * bought a sash the listing had marked unusable.
     */
    const usable = new Set(
    (lastListing ?? []).filter((row) => !row.note).map((row) => row.item.toLowerCase())
  );
    const stock = (world.shop(there.shop)?.items ?? []).filter(
      (item) => affordable(item) && (lastListing === null || usable.has(item.name.toLowerCase()))
    );
    for (const item of stock.slice(0, 6)) {
      const kind = world.itemsNamed([item.name])[item.name]?.kind;
      await say(`buy ${item.name}`, 2000);
      const before = equipRefusals;
      await say(`${kind === 'weapon' ? 'arm' : 'wear'} ${item.name}`, 2000);
      // The refusal names nothing, so this command is the only record of what
      // it refused. Remembered for the run, so the next counter is not walked
      // to for the same item.
      if (equipRefusals > before) {
        unusable.add(item.name.toLowerCase());
        log('phase', `the realm refuses ${item.name} to this character; not buying it again`);
      }
      carried.add(item.name.toLowerCase());
      bought = true;
    }
    if (bought) await say('i', 1500);
    for (const step of back) if (step) await say(step, 1200);
  }
  return bought;
}

/**
 * What this character may walk through unaided: a plain door, and a level
 * gate whose range it is inside. Everything else — a key, a toll, a class —
 * is a wall to this run.
 */
function passable(requirement) {
  if (requirement.kind === 'door') return true;
  if (requirement.kind === 'level') {
    const level = me().progress.level ?? 1;
    return level >= (requirement.minLevel ?? 0) && level <= (requirement.maxLevel ?? 999);
  }
  return false;
}

/** A lair the realm data knows, holding something within this character's reach. */
function nearestLair(exclude, through = passable) {
  const from = hereId();
  if (from === null) return null;
  const level = me().progress.level ?? 1;
  const ceiling = 8 + level * 6;
  return world.nearest(
    from,
    (room) => {
      if (room.name === exclude) return false;
      const mobs = world.lairOf(room);
      // Every monster the lair spawns within reach, and none the realm calls
      // good: a lair is a room the character will stand in for a while.
      return (
        mobs.length > 0 &&
        mobs.every((mob) => mob.hp >= 3 && mob.hp <= ceiling && mob.costly !== 'always')
      );
    },
    through === passable ? 60 : 400,
    through
  );
}

async function main() {
  await session.connect(target());
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline && me().phase !== 'in-game') await wait(250);
  if (me().phase !== 'in-game') {
    log('phase', 'never reached the realm');
    session.dispose();
    return;
  }
  await wait(2500);
  log('phase', `${me().name} (${me().className}) level ${me().progress.level} in ${hereName()}`);
  await say('who');
  await say('exp');
  await say('i');

  const until = Date.now() + PLAY_MS;
  let ground = HUNT;
  let lastExp = 0;
  let lastCheck = Date.now();
  let shopped = false;
  let lastLook = Date.now();
  let lastKills = -1;

  /** The hunting ground, or the nearest lair in range when the ground refuses us. */
  async function reachGround() {
  /*
   * A loop, when the character's options define one: this is what a player
   * actually does all evening, and the driver should exercise the same thing.
   * The loop walks; auto-combat fights what it meets; this only watches, and
   * reports a line per lap so the record shows the rate.
   */
  const loops = session.loopNames;
  if (process.env.PLAY_LOOP === '1' && loops.length > 0) {
    const loop = session.loopNamed(loops[0]);
    const refused = session.loops.start(loop, me());
    log('phase', refused ? `loop refused: ${refused}` : `looping ${loop.name} (${loop.stops.length} stops)`);
    if (!refused) {
      let lastLap = 0;
      let restarts = 0;
      let redials = 0;
      while (Date.now() < until) {
        await wait(15000);
        /*
         * Overnight resilience: a dropped socket must not end five hours of
         * grinding. Reconnect, wait out the login automation, restart the
         * loop. Bounded, because a server that is down stays down.
         */
        if (me().phase !== 'in-game') {
          if (redials >= 5) {
            log('phase', 'connection lost and redials spent; giving up the loop');
            break;
          }
          redials += 1;
          log('phase', `connection lost; redialling (${redials})`);
          try {
            await session.connect(target());
          } catch (error) {
            log('phase', `redial failed: ${error?.message ?? error}`);
            await wait(30000);
            continue;
          }
          const back = Date.now() + 60_000;
          while (Date.now() < back && me().phase !== 'in-game') await wait(500);
          if (me().phase !== 'in-game') continue;
          await say('rm', 1500);
          const again = session.loops.start(loop, me());
          log('phase', again ? `loop refused after redial: ${again}` : 'loop resumed after redial');
          if (again) break;
          continue;
        }
        const p = session.loops.progress;
        if (p.laps !== lastLap) {
          lastLap = p.laps;
          log('phase', `lap ${p.laps}, level ${me().progress.level}, exp ${me().progress.expThisSession}, hp ${Math.round((health() ?? 0) * 100)}%, needed ${me().progress.expNeeded ?? '?'}`);
        }
        /*
         * The level is earned: break the loop, train, come back. The
         * tracker keeps `expNeeded` live off the gain lines, so no `exp` is
         * spent asking. The loop is stopped first because a walk to the guild
         * under a live loop is a walk the loop would replan away from.
         */
        if ((me().progress.expNeeded ?? 1) <= 0 && !me().inCombat) {
          log('phase', 'level is there; pausing the loop to train');
          session.loops.stop('training');
          const guild = await walkTo(GUILD, 25);
          if (!guild) {
            await say('train', 3000);
            await say('exp');
            // A level moved the maxima; the sheet is the cheap way to learn them.
            await say('health');
            log('phase', `trained: level ${me().progress.level}`);
          } else log('phase', `could not reach the guild: ${guild}`);
          const again = session.loops.start(loop, me());
          if (again) {
            log('phase', `loop refused after training: ${again}`);
            break;
          }
          continue;
        }
        /*
         * Death insurance: everything is on the temple floor and a naked
         * character grinding with its fists earns nothing and dies again.
         * The starter shops give the padded set away, so being broke is no
         * excuse not to dress.
         */
        // Only when a listing has been seen: a fresh session's empty state
        // is ignorance, not nakedness, and shopping on it wasted a night.
        const listed = me().inventory.wealth !== null;
        const naked = !me().inventory.items.some((item) => item.equipped);
        if (listed && naked && !me().inCombat && me().inventory.items.length === 0) {
          log('phase', 'naked mid-loop; pausing to re-equip');
          session.loops.stop('re-equipping');
          await say('i', 2000);
          if (!me().inventory.items.some((item) => item.equipped)) {
            if (await shop()) log('phase', 're-equipped');
          }
          const again = session.loops.start(loop, me());
          if (again) {
            log('phase', `loop refused after re-equipping: ${again}`);
            break;
          }
          continue;
        }
        if (p.status !== 'running') {
          log('phase', `loop ended: ${p.reason ?? 'stopped'}`);
          /*
           * A lost location is recoverable: `rm` answers with coordinates,
           * which resolve exactly. Bounded, because a loop that dies for a
           * different reason every minute is a finding, not a retry case.
           */
          if (restarts < 8) {
            restarts += 1;
            await say('rm', 1500);
            const again = session.loops.start(loop, me());
            log('phase', again ? `loop restart refused: ${again}` : `loop restarted (${restarts})`);
            if (!again) continue;
          }
          break;
        }
      }
    }
  }

  const failed = await walkTo(ground);
    if (!failed) return true;
    log('phase', `could not reach ${ground}: ${failed}`);
    let lair = nearestLair(ground);
    /*
     * TEST REALM ONLY: nothing walkable in range (Newhaven is fenced by level
     * gates and a locked pier door), so the operator's teleport takes the
     * character to the nearest lair in range by any path at all. PLAY_SYS=1,
     * never in src/ — see docs/game-behaviour.md.
     */
    if ((!lair || lair.steps.length === 0) && process.env.PLAY_SYS === '1' && hereId() !== null) {
      lair = nearestLair(ground, () => true);
      if (lair && lair.steps.length > 0) {
        const there = lair.steps.at(-1);
        const [map, room] = there.to.split('/');
        log('phase', `TEST REALM ONLY: sys go ${map} ${room} to ${there.name}`);
        await say(`sys go ${map} ${room}`, 3000);
        if (hereName().toLowerCase() === there.name.toLowerCase()) {
          ground = there.name;
          return true;
        }
      }
    }
    if (!lair || lair.steps.length === 0) return false;
    const there = lair.steps.at(-1);
    log('phase', `trying ${there.name} instead (${lair.steps.length} steps, ${world.lairOf(world.byId(there.to)).map((m) => `${m.name}(${m.hp})`).join(', ')})`);
    const went = await walkTo(there.name, 60);
    if (went) {
      log('phase', `could not reach it: ${went}`);
      return false;
    }
    ground = there.name;
    return true;
  }
  await reachGround();

  while (Date.now() < until) {
    if (me().phase !== 'in-game') {
      log('phase', 'left the realm; stopping');
      break;
    }
    const h = health();
    if (h !== null && h < RETREAT_BELOW && !me().inCombat) {
      log('phase', `retreating at ${Math.round(h * 100)}%`);
      const road = await walkTo(REST, 14);
      if (road) log('phase', `retreat failed: ${road}`);
      await restUntilWell();
      await reachGround();
      continue;
    }
    if (me().inCombat) {
      await wait(1000);
      continue;
    }
    // Every couple of minutes: how the levelling is going, and whether to shop.
    if (Date.now() - lastCheck > 120_000) {
      lastCheck = Date.now();
      await say('exp');
      const gained = me().progress.expThisSession;
      log('phase', `exp this session ${gained} (+${gained - lastExp}), level ${me().progress.level}, wealth ${me().inventory.wealth}`);
      lastExp = gained;
      if ((me().progress.expNeeded ?? 1) <= 0) {
        log('phase', 'experience for the next level is there; asking the guild');
        const guild = await walkTo(GUILD, 20);
        if (!guild) {
          await say('train', 3000);
          await say('exp');
          // A level moved the maxima; the sheet is the cheap way to learn them.
          await say('health');
        } else log('phase', `could not reach the guild: ${guild}`);
        await reachGround();
        continue;
      }
      await say('i');
      // Naked — after a death, everything is on the temple floor — the starter
      // shops give the padded set and a weapon away, so wealth is no gate.
      const naked = !me().inventory.items.some((item) => item.equipped);
      if (!shopped && ((me().inventory.wealth ?? 0) >= 1000 || naked)) {
        shopped = true;
        if (await shop()) await reachGround();
      }
      // Nothing to fight for a while: look for a lair within range.
      // After the first check the arena has been done to death by design:
      // the point of this run is to find the next place.
      if (lastKills >= 0) {
        const lair = nearestLair(ground);
        if (lair && lair.steps.length > 0) {
          const there = lair.steps.at(-1);
          log('phase', `arena is quiet; trying ${there.name} (${lair.steps.length} steps, lair of ${world.byId(there.to)?.lair})`);
          const went = await walkTo(there.name, 45);
          if (!went) ground = there.name;
          else log('phase', `could not reach it: ${went}`);
        }
      }
      lastKills += 1;
    }
    /*
     * Idle: nothing to fight and nowhere to go. Wait rather than `l` every
     * few seconds — every look is announced to the room ("Vaelor is looking
     * around the room"), and the maintained listing keeps the room true
     * without it. One look a minute is enough to notice an arrival the
     * broadcasts missed.
     */
    await wait(4000);
    if (Date.now() - lastLook > 60_000) {
      lastLook = Date.now();
      await say('l', 2000);
    }
  }

  // Never hang up in the arena: a monster targeting the character makes the
  // disconnect unclean, and this realm penalises that (docs/greatermud/combat.md).
  if (me().inCombat) await untilOutOfCombat(60_000);
  const home = await walkTo(ROAD, 45);
  if (home) log('phase', `could not leave the fight before hanging up: ${home}`);
  await say('i');
  log('phase', `done: level ${me().progress.level}, exp ${me().progress.expThisSession} this session, wealth ${me().inventory.wealth}, in ${hereName()} at ${Math.round((health() ?? 0) * 100)}%`);
  /*
   * A run that gained nothing says *which* nothing happened. Without this the
   * only record was "0 experience", which reads as a client defect and was
   * twice a quiet realm.
   */
  if (me().progress.expThisSession === 0) {
    if (sawMonster === 0) {
      log(
        'phase',
        `no experience and no monster ever appeared in ${Math.round(PLAY_MS / 60000)} minutes — ` +
          'the realm was quiet, not the client'
      );
    } else if (blows === 0) {
      log(
        'phase',
        `no experience although ${sawMonster} monster lines arrived and nothing was swung at — ` +
          'auto-combat never engaged, which is the client'
      );
    } else {
      log('phase', `no experience across ${blows} blows against ${sawMonster} monster lines`);
    }
  }
  if (unusable.size > 0) {
    log('phase', `the counters refused this character: ${[...unusable].sort().join(', ')}`);
  }
  session.disconnect();
  await wait(500);
  session.dispose();
  fights.dispose();
  out.end();
}

main().then(
  () => process.exit(0),
  (error) => {
    log('phase', `crashed: ${error?.stack ?? error}`);
    process.exit(1);
  }
);
