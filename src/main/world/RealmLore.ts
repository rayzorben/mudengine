import fs from 'node:fs';
import path from 'node:path';
import {
  SpellMessageBook,
  spellKey,
  spellLoreOf,
  type SpellLore
} from '../../shared/spell-messages';

import {
  emptyLore,
  learn,
  learnSlot,
  loreMaximum,
  type LearnedDeath,
  type MobLore,
  type MobLoreEntry,
  type SlotLoreEntry
} from '../../shared/lore';
import { mobKey, type RoomId } from '../../shared/world';
import { errorMessage } from '../../shared/values';
import { t } from '../app/i18n';
import type { WorldGraph } from './WorldGraph';
import { tuning } from '../app/tuning';

/**
 * What this client knows about how much health a monster has.
 *
 * Two sources behind one question, in order of authority:
 *
 * 1. **The realm data**, which is exact for the monsters it names.
 * 2. **What fighting taught**, for the rest — a derivative realm, a monster
 *    added since the extraction, or a name the stream spells differently.
 *
 * The realm always wins where it speaks. Learned figures are bounds derived
 * from watching (`src/shared/lore.ts`), and a bound never outranks a number.
 *
 * **Keyed by realm, not by character.** How much health a giant rat has is a
 * fact about the *world*, and four characters on one realm should not each have
 * to learn it four times over — nor should a character that switches realms
 * carry the old realm's monsters with it. The realm's own identity is the key,
 * which is also what makes the file shareable and reviewable: it is a list of
 * monsters and numbers, with nothing in it about who fought them.
 *
 * **Writes are lazy and never block the parse path.** `observe` is called from
 * inside block handling, at most once per monster per fight; it mutates memory
 * and schedules a save. A client that fsynced on the last blow of a fight would
 * be doing it at the exact moment it had least to spare.
 */
export interface RealmLoreOptions {
  /** Where the learned file lives. Created on demand. */
  file: string;
  /** How long to wait before writing after a change. */
  saveDelayMs?: number;
  /** Reported when the file cannot be read or written. Never silent. */
  notify?(message: string): void;
}

interface LoreFile {
  v: number;
  /** Keyed by realm identity, so one file serves every realm played. */
  realms: Record<string, Record<string, MobLoreEntry>>;
  /**
   * What listings have printed for each `Worn` code, per realm, keyed by the
   * code as a string. Optional in the file: one written before slots were
   * learned simply has none, and a reader of the older shape ignores the key.
   */
  slots?: Record<string, Record<string, SlotLoreEntry>>;
  /**
   * The start and stop sentences the wire taught for spells the shipped table
   * (`resources/world/spell-messages.csv`) has none for, per realm, keyed by
   * the spell's name. Optional for the same reason `slots` is.
   */
  spells?: Record<string, Record<string, LearnedSpellMessages>>;
  /**
   * How each monster dies, per realm, keyed by `mobKey` — the whole line the
   * server printed immediately before this character's experience line
   * (todo 04, 2026-09-12). Realm data with no column in the shipped database,
   * so the wire is the only source. Optional for the same reason `slots` is.
   */
  deaths?: Record<string, Record<string, LearnedDeath>>;
}

/** What one realm taught about one spell's sentences. Either half may be absent. */
export interface LearnedSpellMessages {
  start?: { text: string; at: number };
  stop?: { text: string; at: number };
}

export class RealmLore {
  private readonly learned = new Map<string, Map<string, MobLoreEntry>>();
  /** The slot words, per realm, per `Worn` code. See `SlotLoreEntry`. */
  private readonly slots = new Map<string, Map<number, SlotLoreEntry>>();
  /** Learned spell sentences, per realm, per spell. See `spellsFor`. */
  private readonly spells = new Map<string, Map<string, LearnedSpellMessages>>();
  /** The learned half of each realm's `SpellLore`, built once per realm. */
  private readonly spellBooks = new Map<string, SpellMessageBook>();
  /** How each monster dies, per realm, per `mobKey`. See `LoreFile.deaths`. */
  private readonly deaths = new Map<string, Map<string, LearnedDeath>>();
  /** The same, sentence → monster, which is the direction the classifier asks. */
  private readonly deathIndex = new Map<string, Map<string, string>>();
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;
  private loaded = false;

  constructor(private readonly options: RealmLoreOptions) {}

  /**
   * The view one realm sees.
   *
   * A narrow object rather than this one, because `CharacterTracker` asks about
   * a monster and must not be able to ask about a *realm* — which is the door
   * through which a character on one realm would read another's monsters.
   */
  forRealm(realm: string, world: WorldGraph | undefined): MobLore {
    const key = realmKey(realm);
    return {
      maximumFor: (name, at) => this.maximumFor(key, world, name, at ?? null),
      observe: (name, outcome) => this.observe(key, name, outcome),
      learnedFor: (name) => this.learnedFor(key, world, name),
      // Resolved by the room, exactly as `maximumFor` above is: the two are
      // read together in one estimate (`combat.healthFor`), and a maximum from
      // row 224 corrected by row 2204's regeneration is a bar drawn from two
      // different monsters. `gnoll scout` folds to 168 a tick; row 224's own
      // figure is 8.
      regenFor: (name, at) => world?.mobAt(name, at ?? null)?.regen ?? null,
      slotWordsFor: (worn) => this.slotWordsFor(key, worn),
      observeSlot: (worn, word, at) => this.observeSlot(key, worn, word, at),
      deathOf: (text) => this.deathOf(key, text),
      observeDeath: (name, text, at) => this.observeDeath(key, name, text, at)
    };
  }

  /* -------------------------------------------------------------- deaths */

  private deathOf(realm: string, text: string): string | null {
    this.load();
    return this.deathIndex.get(realm)?.get(text.trim()) ?? null;
  }

  /**
   * The line before this character's experience line named the target: that
   * is how this monster dies, on this realm, and it is said out loud because
   * a learned sentence takes a monster out of the room on its own from now on.
   * Re-observed unchanged, nothing is written; a different sentence for the
   * same monster replaces the old one, since a name may hold several rows
   * and the latest reading is the one the wire just confirmed.
   */
  private observeDeath(realm: string, name: string, text: string, at: number): void {
    const key = mobKey(name);
    const sentence = text.trim();
    if (key.length === 0 || sentence.length === 0) return;
    this.load();
    let table = this.deaths.get(realm);
    if (!table) {
      table = new Map();
      this.deaths.set(realm, table);
    }
    if (table.get(key)?.text === sentence) return;
    table.set(key, { text: sentence, at });
    this.indexDeaths(realm);
    this.schedule();
    this.options.notify?.(t('notices.world.lore.deathLearned', { mob: key, text: sentence }));
  }

  private indexDeaths(realm: string): void {
    const index = new Map<string, string>();
    for (const [key, entry] of this.deaths.get(realm) ?? []) index.set(entry.text, key);
    this.deathIndex.set(realm, index);
  }

  /**
   * The spell sentences one realm reads by: the shipped table first, and
   * behind it what this realm's wire has taught.
   *
   * Learning is keyed by realm exactly as monster health is — a sentence the
   * server prints for a spell is a fact about the world, not about who cast
   * it — and every learn and unlearn is said out loud, because a persisted
   * sentence that ends a shield is a decision somebody must be able to read.
   */
  spellsFor(realm: string, shipped: SpellMessageBook): SpellLore {
    this.load();
    const key = realmKey(realm);
    let learned = this.spellBooks.get(key);
    if (!learned) {
      learned = new SpellMessageBook();
      for (const [spell, entry] of this.spells.get(key) ?? []) {
        if (entry.start) learned.add(spell, 'start', entry.start.text);
        if (entry.stop) learned.add(spell, 'stop', entry.stop.text);
      }
      this.spellBooks.set(key, learned);
    }
    return spellLoreOf(shipped, learned, {
      learned: (spell, kind, text, at) => {
        let table = this.spells.get(key);
        if (!table) {
          table = new Map();
          this.spells.set(key, table);
        }
        const name = spellKey(spell);
        table.set(name, { ...table.get(name), [kind]: { text, at } });
        this.schedule();
        this.options.notify?.(t('notices.world.lore.spellLearned', { spell: name, kind, text }));
      },
      unlearned: (spell, kind) => {
        const table = this.spells.get(key);
        const name = spellKey(spell);
        const entry = table?.get(name);
        if (!table || !entry) return;
        const { [kind]: gone, ...rest } = entry;
        if (gone === undefined) return;
        if (Object.keys(rest).length === 0) table.delete(name);
        else table.set(name, rest);
        this.schedule();
        this.options.notify?.(
          t('notices.world.lore.spellUnlearned', { spell: name, kind, text: gone.text })
        );
      }
    });
  }

  /* --------------------------------------------------------------- slots */

  private slotWordsFor(realm: string, worn: number): readonly string[] {
    this.load();
    return this.slots.get(realm)?.get(worn)?.words ?? [];
  }

  /**
   * A listing named an item the realm knows and the slot it sits in.
   *
   * Written only when the word is new for the code — `learnSlot` returns its
   * input otherwise — so a character's every `i` does not dirty the file.
   */
  private observeSlot(realm: string, worn: number, word: string, at: number): void {
    if (!Number.isInteger(worn) || worn <= 0) return;
    this.load();
    let table = this.slots.get(realm);
    if (!table) {
      table = new Map();
      this.slots.set(realm, table);
    }
    const before = table.get(worn);
    const after = learnSlot(before, word, at);
    if (after === before || after === undefined) return;
    table.set(worn, after);
    this.schedule();
  }

  /* --------------------------------------------------------------- reads */

  private maximumFor(
    realm: string,
    world: WorldGraph | undefined,
    name: string,
    at: RoomId | null
  ): { max: number | null; source: 'realm' | 'learned' | null; span: [number, number] | null } {
    const key = mobKey(name);

    /*
     * As the server *printed* it, which is not always as the table spells it:
     * a name modifier (`large`, `small`, `thin` — common on the live realm)
     * is decoration the realm's `Monsters` row does not carry, and an exact
     * lookup misses the very row this index exists to supply. `mobAsPrinted`
     * is the rule `classifyOccupant` uses, so the Combat card and the room
     * listing agree about which monster is being fought.
     */
    const known = world?.mobAt(key, at);
    if (known) {
      // And as the row the room resolves it to, where it can: `gnoll scout` is
      // a 100-HP row and an 830-HP one, and a bar drawn against the wrong one
      // says *nearly dead* about something at full health, or the reverse.
      return { max: known.hp, source: 'realm', span: known.span ?? null };
    }

    this.load();
    const max = loreMaximum(this.learned.get(realm)?.get(key));
    // A learned entry with no kill in it yet has a floor and no maximum, which
    // is *not* a maximum of zero: the card shows a damage tally and no bar.
    return max === null ? EMPTY_ANSWER : { max, source: 'learned', span: null };
  }

  /**
   * The record, whole; null when fighting has taught nothing about the name.
   *
   * Gathered across spellings. `observe` files under the name the server
   * printed — `small elite guardsman`, modifier and all — and a card asks with
   * the realm table's bare name, so an exact lookup missed the very fights the
   * record exists for. Every learned entry whose printed name resolves to the
   * asked one is folded in: kills summed, the least kill kept, the most
   * survived kept, the latest time kept. *Resolves*, by the first name on its
   * ladder the realm table knows (`mobAsPrinted`) — never any rung of it: a
   * `giant rat king` the realm names is its own monster and must not fold
   * into the rat, while a `small giant rat` the realm does not name folds
   * onto `giant rat`. A `small` and a `large` guardsman may genuinely differ
   * — the modifier is realm data — and this is the same fold `maximumFor`
   * makes by asking the table.
   */
  private learnedFor(
    realm: string,
    world: WorldGraph | undefined,
    name: string
  ): MobLoreEntry | null {
    this.load();
    const wanted = mobKey(name);
    if (wanted.length === 0) return null;
    const entries = this.learned.get(realm);
    if (!entries) return null;
    const resolve = (printed: string): string => world?.mobAsPrinted(printed)?.name ?? printed;
    const target = resolve(wanted);
    let folded: MobLoreEntry | null = null;
    for (const [key, entry] of entries) {
      if (key !== wanted && resolve(key) !== target) continue;
      folded =
        folded === null
          ? entry
          : {
              kill:
                folded.kill === null
                  ? entry.kill
                  : entry.kill === null
                    ? folded.kill
                    : Math.min(folded.kill, entry.kill),
              survived: Math.max(folded.survived, entry.survived),
              kills: folded.kills + entry.kills,
              at: Math.max(folded.at, entry.at)
            };
    }
    return folded;
  }

  /* -------------------------------------------------------------- writes */

  private observe(
    realm: string,
    name: string,
    outcome: { damage: number; killed: boolean; at: number }
  ): void {
    this.load();
    const key = mobKey(name);
    if (key.length === 0) return;

    let realmEntries = this.learned.get(realm);
    if (!realmEntries) {
      realmEntries = new Map();
      this.learned.set(realm, realmEntries);
    }

    const before = realmEntries.get(key);
    const after = learn(before, outcome);
    // `learn` is pure and returns its input when nothing was learned, so
    // identity is what decides whether the disk needs touching at all.
    if (after === before) return;

    realmEntries.set(key, after);
    if (realmEntries.size > tuning().records.maxLearned) {
      const oldest = realmEntries.keys().next();
      if (!oldest.done && oldest.value !== key) realmEntries.delete(oldest.value);
    }
    this.schedule();
  }

  /* ------------------------------------------------------------ the file */

  /**
   * Read once, on the first question asked.
   *
   * Lazily, because a launch that never enters a fight should never touch it —
   * and because a file that will not parse must be reported where somebody is
   * playing rather than during startup, when the terminal is not yet listening.
   */
  private load(): void {
    if (this.loaded) return;
    this.loaded = true;

    let raw: string;
    try {
      raw = fs.readFileSync(this.options.file, 'utf8');
    } catch (error) {
      // Absent is the ordinary case and is not worth a word. Anything else is.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.options.notify?.(
          t('notices.world.lore.readError', {
            file: this.options.file,
            message: errorMessage(error)
          })
        );
      }
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      /*
       * Kept, not replaced. It is a file somebody could have edited, and
       * starting again from empty would silently discard everything a hundred
       * fights taught. Learning is suspended until it is fixed or removed,
       * which is said out loud — the alternative is a client that quietly
       * stopped learning.
       */
      // Retried on the next question, so fixing the file resumes learning
      // without a restart — but reported only once, because the alternative is
      // the same sentence after every fight.
      this.loaded = false;
      if (!this.suspended) {
        this.suspended = true;
        this.options.notify?.(
          t('notices.world.lore.parseSuspended', {
            fileName: path.basename(this.options.file),
            message: errorMessage(error)
          })
        );
      }
      return;
    }

    this.suspended = false;

    const file = parsed as Partial<LoreFile>;
    for (const [realm, entries] of Object.entries(file.realms ?? {})) {
      if (typeof entries !== 'object' || entries === null) continue;
      const table = new Map<string, MobLoreEntry>();
      for (const [name, value] of Object.entries(entries)) {
        const entry = readEntry(value);
        if (entry) table.set(mobKey(name), entry);
      }
      this.learned.set(realmKey(realm), table);
    }
    for (const [realm, entries] of Object.entries(file.slots ?? {})) {
      if (typeof entries !== 'object' || entries === null) continue;
      const table = new Map<number, SlotLoreEntry>();
      for (const [code, value] of Object.entries(entries)) {
        const worn = Number(code);
        const entry = readSlotEntry(value);
        if (Number.isInteger(worn) && worn > 0 && entry) table.set(worn, entry);
      }
      this.slots.set(realmKey(realm), table);
    }
    for (const [realm, entries] of Object.entries(file.deaths ?? {})) {
      if (typeof entries !== 'object' || entries === null) continue;
      const table = new Map<string, LearnedDeath>();
      for (const [name, value] of Object.entries(entries)) {
        const entry = readDeathEntry(value);
        if (entry && mobKey(name).length > 0) table.set(mobKey(name), entry);
      }
      this.deaths.set(realmKey(realm), table);
      this.indexDeaths(realmKey(realm));
    }
    for (const [realm, entries] of Object.entries(file.spells ?? {})) {
      if (typeof entries !== 'object' || entries === null) continue;
      const table = new Map<string, LearnedSpellMessages>();
      for (const [name, value] of Object.entries(entries)) {
        const entry = readSpellEntry(value);
        if (entry && spellKey(name).length > 0) table.set(spellKey(name), entry);
      }
      this.spells.set(realmKey(realm), table);
    }
  }

  /** True once the file was found unparseable; nothing is written over it. */
  private suspended = false;

  private schedule(): void {
    if (this.suspended || this.timer !== null) return;
    this.dirty = true;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.save();
    }, this.options.saveDelayMs ?? tuning().records.loreSaveDelayMs);
    // Never a reason to hold the process open: what is unwritten is one fight's
    // worth of an estimate that improves with the next fight anyway.
    this.timer.unref?.();
  }

  /**
   * Writes what has been learned.
   *
   * Temp file and rename, like every other file this client owns — a crash
   * mid-write must not be able to leave a half-written file that then refuses
   * to parse and suspends learning for good.
   */
  save(): void {
    if (this.suspended || !this.dirty) return;
    this.dirty = false;

    const realms: LoreFile['realms'] = {};
    for (const [realm, entries] of this.learned) {
      if (entries.size === 0) continue;
      realms[realm] = Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : 1)));
    }

    const slots: NonNullable<LoreFile['slots']> = {};
    for (const [realm, table] of this.slots) {
      if (table.size === 0) continue;
      slots[realm] = Object.fromEntries(
        [...table].sort(([a], [b]) => a - b).map(([worn, entry]) => [String(worn), entry])
      );
    }

    const spells: NonNullable<LoreFile['spells']> = {};
    for (const [realm, table] of this.spells) {
      if (table.size === 0) continue;
      spells[realm] = Object.fromEntries([...table].sort(([a], [b]) => (a < b ? -1 : 1)));
    }

    const deaths: NonNullable<LoreFile['deaths']> = {};
    for (const [realm, table] of this.deaths) {
      if (table.size === 0) continue;
      deaths[realm] = Object.fromEntries([...table].sort(([a], [b]) => (a < b ? -1 : 1)));
    }

    const temporary = `${this.options.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.options.file), { recursive: true });
      fs.writeFileSync(
        temporary,
        `${JSON.stringify(
          {
            v: 1,
            realms,
            ...(Object.keys(slots).length > 0 ? { slots } : {}),
            ...(Object.keys(spells).length > 0 ? { spells } : {}),
            ...(Object.keys(deaths).length > 0 ? { deaths } : {})
          } satisfies LoreFile,
          null,
          2
        )}\n`
      );
      fs.renameSync(temporary, this.options.file);
    } catch (error) {
      this.dirty = true;
      this.options.notify?.(
        t('notices.world.lore.writeError', {
          file: this.options.file,
          message: errorMessage(error)
        })
      );
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
        // Nothing useful to do about a temp file that will not go away, and
        // failing here would replace a warning with a crash.
      }
    }
  }

  /** Writes anything outstanding and stops the timer. Called on quit. */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.save();
  }
}

const EMPTY_ANSWER = { max: null, source: null, span: null } as const;

/** One learned death sentence, or null when the row holds none. */
function readDeathEntry(value: unknown): LearnedDeath | null {
  if (typeof value !== 'object' || value === null) return null;
  const { text, at } = value as Record<string, unknown>;
  if (typeof text !== 'string' || text.trim().length === 0) return null;
  return { text: text.trim(), at: typeof at === 'number' && Number.isFinite(at) ? at : 0 };
}

/** One learned spell entry, or null when neither half is a sentence. */
function readSpellEntry(value: unknown): LearnedSpellMessages | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const half = (raw: unknown): { text: string; at: number } | undefined => {
    if (typeof raw !== 'object' || raw === null) return undefined;
    const { text, at } = raw as Record<string, unknown>;
    if (typeof text !== 'string' || text.trim().length === 0) return undefined;
    return { text: text.trim(), at: typeof at === 'number' && Number.isFinite(at) ? at : 0 };
  };
  const start = half(record['start']);
  const stop = half(record['stop']);
  if (!start && !stop) return null;
  return { ...(start ? { start } : {}), ...(stop ? { stop } : {}) };
}

/** One slot entry, or null. Only non-empty strings count as words. */
function readSlotEntry(value: unknown): SlotLoreEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const words = Array.isArray(record['words'])
    ? [
        ...new Set(
          record['words'].filter((w): w is string => typeof w === 'string' && w.trim().length > 0)
        )
      ].sort()
    : [];
  if (words.length === 0) return null;
  const at = record['at'];
  return { words, at: typeof at === 'number' && Number.isFinite(at) ? at : 0 };
}

/**
 * The key one realm's monsters are stored under.
 *
 * The realm file's own name, which is what `WorldMeta.source` carries and what
 * the Session card shows — so a file somebody opens is readable against the
 * realm they are playing. Lowercased and stripped of anything that is not a
 * plain name so the file cannot grow keys that are really paths.
 */
export function realmKey(realm: string): string {
  const name = realm
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    // Runs of separators collapse and the ends are trimmed, so `../../x` cannot
    // survive as a key that still reads as a path.
    .replace(/[.\-_]{2,}/g, '-')
    .replace(/^[.\-_]+|[.\-_]+$/g, '');
  return name.length > 0 ? name : 'unknown';
}

/** One entry, or null. Every field is checked; none is coerced to zero. */
function readEntry(value: unknown): MobLoreEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;

  const kill = record['kill'];
  const survived = record['survived'];
  const kills = record['kills'];
  const at = record['at'];

  const entry = emptyLore();
  if (typeof kill === 'number' && Number.isFinite(kill) && kill > 0) entry.kill = kill;
  if (typeof survived === 'number' && Number.isFinite(survived) && survived > 0) {
    entry.survived = survived;
  }
  if (typeof kills === 'number' && Number.isFinite(kills) && kills > 0) entry.kills = kills;
  if (typeof at === 'number' && Number.isFinite(at)) entry.at = at;

  // An entry with nothing in it is not an entry. Keeping one would let a file
  // of empty objects fill the cap and evict real ones.
  return entry.kill === null && entry.survived === 0 ? null : entry;
}
