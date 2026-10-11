/**
 * What each monster has done to this character in the fight running, and the
 * record written of it when the fight ends (todo 26). Composed by
 * `FightTracker`, which hands in every line on the character; the prediction
 * is asked for once, at a monster's first line, so it is the one the fight
 * was opened against. Settled at `*Combat Off*`, when the state shows no fight
 * and at the character's death,
 * forgotten (written nowhere) on a new session or a closed socket.
 */
import type { Block } from '../../shared/blocks';
import type { CharacterState } from '../../shared/character';
import { wornGear } from '../../shared/fights';
import type { HarmBlow, HarmEnd, HarmRecord, HarmSink } from '../../shared/harm';
import { mobKey } from '../../shared/world';
import { tuning } from '../app/tuning';

/**
 * A line on the character read as a blow, a cast or a miss.
 *
 * A cast is the server's spell message: `Dao Lord casts earthfist on you for
 * 160 damage!`, or the article-led effect line that names no caster, `A
 * whirlwind of fire burns you for 13 damage!` (25 lines in captures/, each
 * after the caster's own gesture line, which nothing reads yet). A monster's
 * melee blow is `[The ]<Name> <hits> you for N damage!` (`Mob.cs:1387`).
 * A `mob-misses` is a miss. Since todo 56 a hit spell's or damage shield's
 * `You are shocked for 3 damage!` is `user-takes-damage`, which names nobody,
 * and reads as a cast.
 */
export function harmOf(block: Pick<Block, 'type' | 'text' | 'groups'>): HarmBlow | null {
  if (block.type === 'mob-misses') return { kind: 'miss' };
  if (block.type !== 'mob-hits' && block.type !== 'user-takes-damage') return null;
  const damage = Number(block.groups['damage']);
  if (!Number.isFinite(damage)) return null;
  // Damage naming nobody is a message row's second line: a hit spell or a damage shield.
  if (block.type === 'user-takes-damage') return { kind: 'spell', damage };
  const spell =
    /^(?:A|An) /.test(block.text) || /\bcasts [^"]+? on (?:you|your body)\b/.test(block.text);
  return { kind: spell ? 'spell' : 'melee', damage };
}

/** One monster's lines on the character so far, and the character as it was at the first. */
type Open = Omit<HarmRecord, 'at' | 'ended'>;

const NOBODY = '';

export class HarmLedger {
  private readonly open = new Map<string, Open>();

  constructor(private readonly sink: Pick<HarmSink, 'harm' | 'predict'>) {}

  /** A line on the character. `attacker` undefined is a line nobody could be named for. */
  struck(s: CharacterState, at: number, attacker: string | undefined, blow: HarmBlow): void {
    // A miss nobody is named for is the loose `mob-misses` shape: any sentence
    // about something standing here. It harmed nothing, so it is no fight.
    if (attacker === undefined && blow.kind === 'miss') return;
    const key = attacker === undefined ? NOBODY : mobKey(attacker);
    const held = this.open.get(key) ?? this.opening(s, at, key);
    held.lastAt = at;
    switch (blow.kind) {
      case 'miss':
        held.misses += 1;
        break;
      case 'melee':
        held.hits += 1;
        held.meleeDamage += blow.damage;
        break;
      case 'spell':
        held.casts += 1;
        held.spellDamage += blow.damage;
        break;
      default: {
        const never: never = blow;
        throw new Error(`unhandled harm blow ${JSON.stringify(never)}`);
      }
    }
  }

  /** The fight is over: one record per monster, written. */
  settle(at: number, ended: HarmEnd): void {
    for (const held of this.open.values()) this.sink.harm({ ...held, at, ended });
    this.open.clear();
  }

  forget(): void {
    this.open.clear();
  }

  private opening(s: CharacterState, at: number, key: string): Open {
    const joined = [...this.open.keys()].some((other) => other !== NOBODY);
    const held: Open = {
      mob: key === NOBODY ? null : key,
      firstAt: at,
      lastAt: at,
      misses: 0,
      hits: 0,
      meleeDamage: 0,
      casts: 0,
      spellDamage: 0,
      joined: key !== NOBODY && joined,
      level: s.progress.level,
      hp: s.vitals.hp,
      hpMax: s.vitals.hpMax,
      armourClass: s.progress.armourClass,
      damageResist: s.progress.damageResist,
      magicRes: s.progress.magicRes,
      gear: wornGear(s.inventory.items),
      predicted: key === NOBODY ? null : this.sink.predict(key, s)
    };
    this.open.set(key, held);
    // Bounded like the ledgers: a room full of things must not grow this. The
    // oldest is written as it stands rather than lost.
    if (this.open.size > tuning().parse.maxLedgers) {
      const oldest = this.open.entries().next();
      if (!oldest.done && oldest.value[0] !== key) {
        this.sink.harm({ ...oldest.value[1], at, ended: 'off' });
        this.open.delete(oldest.value[0]);
      }
    }
    return held;
  }
}
