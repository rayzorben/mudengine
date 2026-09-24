/**
 * Keeping a room's ward up off a carried item (todo 105, 2026-09-21).
 *
 * The desert between the Ornate Tent and the Small Pyramid is sixty-four
 * rooms each way, every one of them casting a spell the realm says is stopped
 * by another spell (`SpellHazard.avoidedBySpell`, 711 *waterskin*), and the
 * only thing that casts that spell is using a waterskin (`Items.Abil-n =
 * CastsSp`, three uses, six hundred ticks). The plan buys the skins; nothing
 * used one. This does: before a step into a room whose spell a carried item's
 * spell would stop, and again whenever that spell lapses while standing in
 * one, `use <item>` goes out ahead of the step in the walk's own band.
 *
 * ## The clock is the client's own, and it says so
 *
 * A `use` prints the item's sentence — *You take a swig of water from your
 * waterskin.* — and no `You feel …` frame, so the tracker records no buff and
 * `Blessings` never sees it. The spell is taken as up for the realm's stated
 * duration from the moment the use went out, a tick every three seconds —
 * `EffectSpellTickTime`, the clock `SpellEffectManager.Tick` counts
 * `DurationLeft` down on (docs/greatermud/combat.md) — so a waterskin's six
 * hundred ticks are thirty minutes. The router prices on none of this
 * (`Traveller.spellsUp` is stated countdowns alone); this keeps the walk
 * safe, and the plan already prices the leg as carrying the skins.
 *
 * On by default (`automation.health.useWards`, todo 02: the realm's own half
 * of the *when to use an item* rules, beside the player's own). A use spends
 * a charge; the desert spends 13 hit points a tick.
 * See `mudengine-automation` § *A room's ward is kept up off the pack*.
 */
import type { CommandQueue } from './CommandQueue';
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { Priority } from '../../shared/automation';
import type { CharacterState } from '../../shared/character';
import type { HealthConfig } from '../../shared/config';
import { bareName } from '../../shared/items';
import { EFFECT_TICK_SECONDS } from '../../shared/menace';
import {
  hazardAvoided,
  nameAnswersTo,
  type RoomId,
  type SpellHazard,
  type WorldItem,
  type WorldSpell
} from '../../shared/world';

export interface WardSources {
  /** The room's own spell and what it does, or null where it casts nothing the reader could follow. */
  hazardAt(room: RoomId): { spell: WorldSpell; hazard: SpellHazard } | null;
  /** The items whose use casts this spell, off the realm's item table. */
  itemsCasting(spell: number): readonly WorldItem[];
  spellById(id: number): WorldSpell | null;
  /** The spells the server has stated up with a countdown still running. */
  spellsUp(state: CharacterState): readonly number[];
}

export interface WardEvents {
  notice?(message: string): void;
}

/** One tick of a spell's duration, on the server's own clock. */
const TICK_MS = EFFECT_TICK_SECONDS * 1000;

export class Wards {
  /** When each ward this module used lapses, by spell, on the client's own clock. */
  private readonly until = new Map<number, number>();
  /** When each ward was last asked for, so a use the server swallowed is not repeated per line. */
  private readonly askedAt = new Map<number, number>();
  /** Hazards already said to want a ward nothing carried casts, once each. */
  private readonly saidNothing = new Set<number>();
  /** On for a quest run whatever the switch says: the plan bought the wards to be used. */
  private lent = false;

  constructor(
    private config: HealthConfig,
    private enabled: boolean,
    private readonly queue: CommandQueue,
    private readonly sources: WardSources,
    private readonly events: WardEvents = {},
    private readonly now: () => number = () => Date.now()
  ) {}

  configure(config: HealthConfig, enabled: boolean): void {
    // The player turning the switch off by hand ends the lend, as it ends a
    // combat lease: a reload saying otherwise is their edit and wins.
    if (this.lent && this.config.useWards && !config.useWards) {
      this.lent = false;
      this.events.notice?.(t('automation.wards.lendEnded'));
    }
    this.config = config;
    this.enabled = enabled;
  }

  reset(): void {
    this.until.clear();
    this.askedAt.clear();
    this.saidNothing.clear();
    this.lent = false;
  }

  /**
   * A death strips every effect without a word (`Player.Killed` →
   * `RemoveSpellAbilities`, Player.cs:1406), so a ward this clock still has
   * up is gone.
   */
  died(): void {
    this.until.clear();
    this.askedAt.clear();
  }

  /**
   * Wards lent for a quest run whose plan bought them, as auto-combat is lent
   * for a route: session-scoped, never written to the file, said both ways
   * where the switch is off. See `mudengine-automation` › *A quest's plan is
   * carried step by step*.
   */
  lend(on: boolean): void {
    if (on !== this.lent && !this.config.useWards) {
      // Two literal calls: the dictionary's readers are found by the key.
      if (on) this.events.notice?.(t('automation.wards.lentForRun'));
      else this.events.notice?.(t('automation.wards.returnedAfterRun'));
    }
    this.lent = on;
  }

  /** A step is about to go into `to`: the ward for it goes out first, in the same band. */
  beforeStep(to: RoomId, state: CharacterState): void {
    this.keep(to, state, 'movement');
  }

  /** Standing in a warded room while the spell lapses: used again. */
  onCharacter(state: CharacterState, here: RoomId | null): void {
    if (here === null) return;
    // Not while a move is in flight or a fight is running: the step's own
    // `beforeStep` asks again, and a round spent here mid-fight is a round.
    if (state.inCombat || state.combat.attackers.length > 0) return;
    this.keep(here, state, 'probe');
  }

  /** Whether this module's own clock says the spell is still up. */
  private upByClock(spell: number, now: number): boolean {
    const lapses = this.until.get(spell);
    return lapses !== undefined && lapses > now;
  }

  private keep(room: RoomId, state: CharacterState, priority: Priority): void {
    if (!this.enabled || !(this.config.useWards || this.lent)) return;
    // An unlisted pack is not an empty one: nothing is used off a listing
    // nobody has read, and nothing is refused on its account either.
    if (state.inventory.listedAt === null) return;
    const found = this.sources.hazardAt(room);
    if (found === null) return;
    const { spell: cast, hazard } = found;
    const spells = hazard.avoidedBySpell ?? [];
    if (spells.length === 0) return;
    // Carrying what stops it outright — the wristband — wants no ward at all.
    if (hazardAvoided(hazard, state.inventory.rows)) return;
    const now = this.now();
    const stated = this.sources.spellsUp(state);
    if (spells.some((id) => stated.includes(id) || this.upByClock(id, now))) return;

    for (const id of spells) {
      for (const item of this.sources.itemsCasting(id)) {
        const carried = state.inventory.items.find((each) =>
          nameAnswersTo(bareName(each.name), bareName(item.name))
        );
        if (carried === undefined) continue;
        /*
         * The same retry floor a blessing's own recast uses. A `use` the
         * server refused, or answered with a sentence this client does not
         * read, must not go out again on every status line — and one that
         * took has the clock below to say so.
         */
        const asked = this.askedAt.get(id) ?? 0;
        if (now - asked < tuning().spells.blessRetryMs) return;
        this.askedAt.set(id, now);
        const name = bareName(carried.name);
        const ward = this.sources.spellById(id);
        const lasts = ward?.duration;
        this.queue.enqueue({
          // The item's own name as the pack listed it: `use` reads everything
          // before the last word as the item, so nothing is appended.
          command: `use ${name}`,
          priority,
          coalesceKey: `ward:${id}`,
          expiresAt: now + tuning().spells.buffExpiresMs,
          reason: t('automation.wards.reason', {
            item: name,
            spell: ward?.name ?? String(id),
            hazard: cast.name
          }),
          onSent: () => {
            if (lasts !== undefined && lasts > 0) this.until.set(id, this.now() + lasts * TICK_MS);
          }
        });
        this.events.notice?.(
          t('automation.wards.using', {
            item: name,
            spell: ward?.name ?? String(id),
            hazard: cast.name
          })
        );
        return;
      }
    }
    // Nothing carried casts any of them: said once per hazard, because the
    // plan's supply row is the answer and this cannot buy one.
    if (this.saidNothing.has(cast.id)) return;
    this.saidNothing.add(cast.id);
    this.events.notice?.(
      t('automation.wards.nothingCarried', {
        hazard: cast.name,
        spells: spells.map((id) => this.sources.spellById(id)?.name ?? String(id)).join(', ')
      })
    );
  }
}
