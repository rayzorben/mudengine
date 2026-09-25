/**
 * The buffs and effects on the character — beside the sheet (`sheet.ts`), which
 * it leans on and which never imports it: a file of its own because it owns a
 * memory the sheet's folds do not, and changes when the learning does. The
 * conditions an effect turns on and off go through `sheet.ts`'s `afflicted`,
 * which every condition sentence writes through.
 */
import {
  NO_AFFLICTIONS,
  type ActiveBuff,
  type Afflictions,
  type CharacterState
} from '../../shared/character';
import {
  effectKey,
  isUnnamedEffect,
  spellKey,
  splitSpells,
  unnamedEffect,
  unnamedEffectSentence,
  wordsOf,
  type SpellLore
} from '../../shared/spell-messages';
import { confuses, holdsMovement } from '../../shared/spellcraft';
import type { BelongingsSink } from '../../shared/belongings';
import type { Block } from '../../shared/blocks';
import { tuning } from '../app/tuning';
import type { WorldGraph } from '../world/WorldGraph';
import type { Expectations } from './expectations';
import { afflictionOnset } from './patterns';
import { afflicted } from './sheet';

/** The realm's spell rows as the buffs read them: a hold, a confusion, a duration, a spelling. */
export type SpellWorld = Pick<WorldGraph, 'spellNamed'>;

/** What the buffs read from the rest of the character, handed in as `RoomSources` are. */
export interface EffectSources {
  /** The realm, where one is loaded; without it a spell is only the words it was printed in. */
  world: SpellWorld | undefined;
  /** The realm's sentences for an effect landing and ending, and where a new one is taught. */
  spellLore: SpellLore;
  /** The queue's one reader a hold spends: the move it refused (`Expectations.shiftHeldMove`). */
  claims: Pick<Expectations, 'shiftHeldMove'>;
  /** Where a measured duration is written; `CharacterTracker.useBelongings` swaps it. */
  belongings(): Pick<BelongingsSink, 'rememberSpellDuration'>;
}

/**
 * Every affliction, taken from the zero value so the list cannot drift from
 * the type it enumerates — the two halves of a closed union, in one place.
 */
const AFFLICTIONS = Object.keys(NO_AFFLICTIONS) as ReadonlyArray<keyof Afflictions>;

/** A list-size bound on the buffs, not a knob: nothing legitimate holds this many. */
const KEPT_BUFFS = 15;

/**
 * Whether a line nothing recognised is shaped like an effect sentence: one
 * sentence, beginning with a capital and ending in a full stop or a bang,
 * carrying no figure and no speech, and short. Every start and stop in the
 * shipped table passes; a listing row, a status line, a damage line and a
 * `You say` do not. This is a gate on what may be *learned*, not a reader —
 * nothing is typed from it.
 */
function looksLikeEffectSentence(text: string): boolean {
  if (!/^[A-Z][^\d"]*[.!]$/.test(text)) return false;
  return wordsOf(text).length <= 14;
}

/**
 * The buffs and effects on the character, and what their sentences teach.
 *
 * Owns the learning `mudengine-wire` › *A buff's own sentences are data, read
 * from a table, and learned where the table is silent* describes: the cast an
 * onset follows, the endings nothing recognised and the onsets a sheet will
 * settle, and when each effect and condition last ended, for `deduceCauses`.
 * A cast, an onset, a wear-off, the `st` sheet and a line nothing read each
 * reach it through one method; what it may not own — the queue, the realm, the
 * record on disk — it is handed (`EffectSources`).
 */
export class EffectTracker {
  private readonly world: SpellWorld | undefined;
  private readonly spellLore: SpellLore;
  /** The one reach into the command queue: a hold refusing the move at its head. */
  private readonly expect: Pick<Expectations, 'shiftHeldMove'>;
  /**
   * This character's own most recent duration-spell cast, for learning what
   * the per-spell onset sentence that follows it is called.
   *
   * The onset (`You feel safe from evil!`) names an effect the realm's message
   * table would map to `protection from evil`, and none of the realm databases
   * on hand export that table — but the onset arrives the instant after the
   * cast confirmation, which does name the spell, so the pair is learned from
   * that adjacency. Session-scoped: a buff is re-cast every session and the
   * `st` timer is a live read, so nothing has to persist.
   */
  private lastSelfCast: { spell: string; at: number } | null = null;
  /** Learned `onset effect (lower) → spell name`, so the `st` timer can be attributed. */
  private buffEffects = new Map<string, string>();
  /**
   * Sentences nothing recognised, seen while buffs whose ending the client
   * does not know were up — each with the buffs it could have ended. An `st`
   * sheet resolves them: a suspect the sheet still lists is not it, and one
   * suspect left that the sheet has stopped listing is the buff the sentence
   * ended, which is then learned. Bounded, and aged out by
   * `tuning.spells.pendingStopMs`.
   */
  private pendingStops: Array<{ text: string; at: number; suspects: string[] }> = [];
  /**
   * Buffs a *learned* ending removed, by spell key, with when. A buff that
   * reappears unprompted inside `tuning.spells.stopContradictionMs` — the
   * `st` sheet still listing it, typically — is the wire saying the learned
   * sentence was not its ending, and the lesson is taken back.
   */
  private readonly recentlyStopped = new Map<string, number>();
  /**
   * Whether an `st` sheet would settle something: a sentence nothing
   * recognised has just been read as, or held as, the ending of a buff whose
   * start the sheet would print. Set here, taken by `takeSheetRequest`, and
   * acted on by `Routines` — the tracker records and never sends.
   */
  private sheetWanted = false;
  /**
   * Sentences nothing recognised that may be an effect *landing*, each
   * waiting for a stat sheet to say so.
   *
   * The learning that was here read only this character's own casts, so a
   * spell somebody else landed could never teach anything: its sentence
   * matched no frame, followed no cast, and was dropped. The sheet is what
   * answers for it — `StatCommand.cs:50` prints `DescMessage.Line3` for every
   * timed effect on the player, which is the very line the spell printed when
   * it landed (`Spell.cs:1233`, `:1360`), friend or foe alike. So a sentence
   * reprinted there is a lasting effect and is learned under its own words
   * (`unnamedEffect`); one the sheet leaves out is not, and *that* is written
   * down too, so `You are poisoned!` answering a `rest` costs this realm one
   * `st` in its lifetime rather than one per sighting.
   *
   * Bounded and aged out by `tuning.spells.pendingStopMs`, as the endings are.
   */
  private pendingOnsets: Array<{ text: string; at: number; stopFor?: string }> = [];
  /**
   * When each unnameable effect last ended, and when each condition last did,
   * so that the two — printed as separate sentences, in either order — can be
   * read as the one event that confirms what the effect causes. Both are
   * bounded by the buff list and by the four conditions. See `deduceCauses`.
   */
  private readonly effectEnded = new Map<string, number>();
  private readonly conditionEnded = new Map<keyof Afflictions, number>();

  constructor(private readonly sources: EffectSources) {
    this.world = sources.world;
    this.spellLore = sources.spellLore;
    this.expect = sources.claims;
  }

  /** A new connection: everything learned this session goes, the cast and the onset map with it. */
  forget(): void {
    this.lastSelfCast = null;
    this.buffEffects.clear();
    this.leaveRealm();
  }

  /** The buffs go with the realm, and so does every half-learned ending. */
  leaveRealm(): void {
    this.pendingStops = [];
    this.pendingOnsets = [];
    this.effectEnded.clear();
    this.conditionEnded.clear();
    this.recentlyStopped.clear();
    this.sheetWanted = false;
  }

  /**
   * Whether an `st` sheet has been wanted since this was last asked.
   *
   * A flag taken rather than an event fired, because the answer is wanted
   * once per burst of questions, not once per line: three emotes in a row
   * while one buff's ending is unknown are one sheet. Cleared by the taking.
   */
  takeSheetRequest(): boolean {
    const wanted = this.sheetWanted;
    this.sheetWanted = false;
    return wanted;
  }

  /** `spell-cast`: a confirmation naming this character establishes a buff. */
  cast(s: CharacterState, g: Block['groups'], at: number): CharacterState | null {
    const spell = g['spell']?.trim();
    const caster = g['caster'];
    const target = g['target']?.toLowerCase();
    if (!spell || caster === undefined) return null;
    // The pre-cast announcement (`moves to cast … upon …`), not the
    // confirmation: the cast can still fizzle, and a buff recorded here
    // is a shield believed up for the whole fallback clock while it may
    // never have landed. The confirmation frame follows if it did.
    if (g['announced'] !== undefined) return null;
    // An amount makes it an instant heal or blow, not a duration spell.
    if (g['amount'] !== undefined) return null;
    const own = s.name?.toLowerCase() ?? null;
    /*
     * A cast with no `on <target>` frame is a **self** cast — `You cast
     * protection from evil, and Festus is surrounded in a white glow!` —
     * so an absent target from `You` is this character. A named target
     * must still be this character (`yourself`, `you`, or its own name);
     * a party member's buff wears off on their screen, not this one's.
     */
    const isSelf =
      target === undefined
        ? caster === 'You'
        : target === 'yourself' || target === 'you' || (own !== null && target === own);
    if (!isSelf) return null;
    // Remember it, so the onset that follows can be learned against it.
    this.lastSelfCast = { spell, at };
    /*
     * Only what the realm calls a duration spell, where the realm can
     * say: an instant cure tracked as a buff would sit on the list for
     * ever, since no wear-off is coming. A spell the realm cannot name is
     * kept — refusing it would untrack every buff on a derivative realm —
     * and its life is bounded by the configured fallback clock.
     */
    const known = this.world?.spellNamed(spell) ?? null;
    if (known !== null && known.duration === undefined) return null;
    const kept = s.buffs.filter((buff) => buff.spell.toLowerCase() !== spell.toLowerCase());
    return {
      ...s,
      buffs: [
        ...kept.slice(-KEPT_BUFFS),
        { spell, by: caster === 'You' ? null : caster, appliedAt: at }
      ]
    };
  }

  /** `spell-onset`: a buff's own sentence landing, learned against the cast it follows. */
  onset(s: CharacterState, block: Block): CharacterState | null {
    const g = block.groups;
    const effect = g['effect']?.trim().toLowerCase();
    const candidates = splitSpells(g['spells']);
    const cast = this.lastSelfCast;
    const followsCast = cast !== null && block.at - cast.at <= tuning().spells.onsetWindowMs;

    /*
     * **A hold is an onset the character cannot walk out of**, and the
     * realm says which onsets those are — see `heldByOnset`. Taken before
     * the buff bookkeeping and folded into whatever it decides, because
     * the two are independent: `You are flat on your back!` establishes a
     * buff *and* stands the walk still, and the branches below return
     * `null` for a sentence that changed no buff.
     */
    const base = this.heldByOnset(s, candidates) ?? s;
    const held = base === s ? null : base;

    /*
     * No table entry: the `You feel …!` frame alone. Everything it can
     * teach comes from the cast it follows — the effect word for the `st`
     * timer, and the whole sentence as that spell's start, so the next
     * time it is printed with no cast in front of it (a potion, the `st`
     * sheet) the buff is still recognised.
     */
    if (candidates.length === 0) {
      if (followsCast) {
        if (effect) this.buffEffects.set(effect, cast.spell);
        this.spellLore.learn(cast.spell, 'start', block.text.trim(), block.at);
        this.lastSelfCast = null;
      }
      return held;
    }

    /*
     * The table names the spells this sentence begins. A cast a moment
     * ago naming one of them settles which — and the cast frame has
     * already put that buff on the list, so this only adds it where the
     * frame refused because the realm's row called the spell instant: the
     * table has just said it lasts, and the table is the server's own
     * statement about this very spell.
     */
    const named = followsCast
      ? candidates.find((candidate) => this.namesOneSpell(candidate, cast.spell))
      : undefined;
    if (followsCast && named !== undefined) {
      if (effect) this.buffEffects.set(effect, cast.spell);
      this.lastSelfCast = null;
      if (base.buffs.some((buff) => this.buffMatches(buff, [cast.spell]))) return held;
      return this.withBuff(base, { spell: cast.spell, by: null, appliedAt: cast.at });
    }

    /*
     * Unprompted: the `st` sheet restating what is up, a potion, an
     * item, or a cast whose frame this client does not read. Already on
     * the list is the common case (the sheet) and changes nothing — the
     * cast's own `appliedAt` is the honest one. Otherwise the buff is
     * established from the sentence itself, named for the one candidate
     * the spellbook knows where that settles it and the first otherwise,
     * with the rest kept as candidates rather than thrown away: `You feel
     * lucky!` is five spells, and a reader asking whether bless is up
     * must be answered yes whichever of the five it really is.
     */
    if (base.buffs.some((buff) => this.buffMatches(buff, candidates))) return held;
    const inBook = candidates.filter((candidate) => this.knowsSpell(base, candidate));
    const spell = inBook.length === 1 ? inBook[0]! : candidates[0]!;
    const rest = candidates.filter((candidate) => candidate !== spell);
    this.noteContradiction(candidates, block.at);
    return this.withBuff(base, {
      spell,
      by: null,
      appliedAt: block.at,
      ...(rest.length > 0 ? { candidates: rest } : {})
    });
  }

  /** `spell-failed`: an onset is not coming for a cast that failed. */
  failed(named: string | undefined): void {
    const spell = named?.trim().toLowerCase();
    if (spell && this.lastSelfCast?.spell.toLowerCase() === spell) this.lastSelfCast = null;
  }

  /** `user-buff-expired`: a wear-off ends the buff it names, and whatever its start turned on. */
  expired(s: CharacterState, g: Block['groups'], at: number): CharacterState | null {
    const spell = g['spell']?.trim();
    const names = splitSpells(g['spells']);
    if (names.length === 0 && spell) names.push(spell);
    if (names.length === 0) return null;
    /*
     * **A wear-off ends whatever its own start turned on**, which for four
     * spells is a *condition* rather than a buff (todo 02, 2026-09-06,
     * reported as *"it doesnt detect blind wearing off"*).
     *
     * `The effects of the mummy's breath wears off!` is the stop sentence
     * of spell 84 in `spell-messages.csv`, whose **start** is `You are
     * blind!`. The onset therefore reached `afflictions.blind` through
     * `user-blinded` and the ending reached here — where nothing on
     * `buffs` matched `breathes`, so the case returned null and the flag
     * stayed `yes` for the rest of the session. Captured in the report:
     * the condition wore off, the character read three rooms in a row, and
     * `Walker` then held a seventeen-step route with *Blind; waiting here
     * until you can see again.*
     *
     * The table already pairs the two sentences, which is the whole of the
     * user's *"start and stop spells should know what effects they are
     * adding and removing"*: ask it what this ending stops, ask it what
     * those spells start, and ask `patterns.ts` what such a sentence turns
     * **on**. One statement of each onset pattern, read from both ends.
     *
     * `blind` is not the only one it answers — the table pairs `You are
     * blind and dizzy!` with `You are no longer blind and dizzy.` and
     * `You are blinded by the sand!` with `You can see again.` (a full
     * stop, which `user-blind-ends` does not match) — and it is silent
     * for every buff whose start is ordinary flavour text, which is all
     * of them but these.
     */
    let next = s;
    for (const name of names) {
      /*
       * The realm's own ability row first, for the hold family: twenty of
       * its stop sentences end a condition whose *start* is message data
       * `patterns.ts` cannot enumerate (`You get back on your feet.` ends
       * six spells, none of which `afflictionOnset` has ever heard of), so
       * the pairing below answers null for every one of them. See
       * `holdsMovement` and `heldByOnset` — one test, read from both ends,
       * exactly as the onset pairing is.
       */
      for (const condition of this.conditionsOf(name)) {
        next = afflicted(next, condition, 'no') ?? next;
      }
    }
    const ended = next.buffs.filter((buff) => this.buffMatches(buff, names));
    // A wear-off naming nothing on the list is still a fact — a debuff
    // ending, or a buff cast before this session — and may have turned a
    // condition off above even when it ends no buff.
    if (ended.length === 0) return next === s ? null : next;
    this.buffsEnded(ended, at, true);
    return { ...next, buffs: next.buffs.filter((buff) => !ended.includes(buff)) };
  }

  /**
   * `player-status`: what the sheet says is up, as `s`'s buffs — and the
   * conditions the dropped ones turned on, off. The figures are `statSheet`'s.
   */
  listed(s: CharacterState, text: string, at: number): CharacterState {
    const buffs = this.readSheet(s, text, at);
    /*
     * **The listing drops what has ended, and so must what it turned on.**
     * A buff the sheet has stopped printing ended without a sentence this
     * client read — which is the very case where the condition it caused
     * would otherwise stand for ever, because nothing else is coming to
     * clear it. Same reading as the wear-off's (`conditionsOf`), from the
     * one side of the listing that removes.
     */
    const dropped = s.buffs.filter((held) => !buffs.some((kept) => kept.spell === held.spell));
    let cleared = s;
    for (const buff of dropped) {
      for (const name of this.buffNames(buff)) {
        for (const condition of this.conditionsOf(name)) {
          cleared = afflicted(cleared, condition, 'no') ?? cleared;
        }
      }
    }
    // Paramud's `st` prints a countdown after each active buff; the
    // batch swallows those lines, so they are read out of the sheet text
    // and attributed through the learned onset map. See `readSheet`.
    return { ...cleared, buffs };
  }

  /**
   * `unknown`: a line nothing read, as evidence about the buffs. `open` says
   * whether it is a line of a listing the classifier is collecting, and
   * whether of the stat sheet — the tracker's to know (`listingOpen`,
   * `sheetOpen`).
   */
  unread(
    s: CharacterState,
    raw: string,
    at: number,
    open: { listing: boolean; sheet: boolean }
  ): CharacterState | null {
    /*
     * **A line inside a listing is that listing's** (2026-09-12). Every
     * line of a batch arrives here typed by the single-line table as
     * well, and only the sheet was exempt (`sheetOpen`, below, which
     * still keeps a sheet line from reading as an ending). The `i`
     * listing's keys row and the `pro` listing's last line were both
     * taken for an effect landing, spent an `st` between them and were
     * written down as *no lasting effect*, out loud, twice. The sheet's
     * own lines lose nothing here: `readSheet` reads them off the batch.
     */
    if (open.listing) return null;
    const text = raw.trim();
    if (!looksLikeEffectSentence(text) || this.namesSomebody(s, text)) return null;
    const cast = this.lastSelfCast;
    if (cast !== null && at - cast.at <= tuning().spells.onsetWindowMs) {
      this.spellLore.learn(cast.spell, 'start', text, at);
      this.lastSelfCast = null;
      return null;
    }
    /*
     * **A line of the sheet is the listing restating what is up**, not an
     * event, so it ends nothing. It is still worth a candidate: the sheet
     * printing a sentence nothing recognises is the positive statement
     * that it is a lasting effect, and `readSheet` reads that off the
     * batch a moment later.
     */
    /*
     * **Every unclaimed sentence is a candidate onset**, whatever else is
     * made of it below. No cast of this character's is in front of it, so
     * it is either an effect somebody else landed — which the learning
     * here could never see, reading own casts only — or the end of one
     * that is up, or no effect at all. The sheet is the one thing that
     * separates the three, and holding the sentence against all of them
     * until it arrives is what stops the client choosing early.
     */
    this.suspectEffect(text, at);
    // A line of the sheet is the listing restating what is up, not an
    // event: it ends nothing.
    if (open.sheet) return null;
    const suspects = s.buffs.filter((buff) => !this.knowsStop(buff));
    if (suspects.length === 0) return null;
    // Either way the sheet is worth asking for, if it can speak: a
    // suspect whose start it would print is one it can confirm gone, or
    // still up — which is the contradiction that takes a lesson back.
    this.sheetWanted ||= suspects.some((buff) => this.knowsStart(buff));
    if (suspects.length === 1) {
      const buff = suspects[0]!;
      this.spellLore.learn(buff.spell, 'stop', text, at);
      this.recentlyStopped.set(spellKey(buff.spell), at);
      this.actedAsStop(text, buff.spell);
      this.buffsEnded([buff], at, false);
      return { ...s, buffs: s.buffs.filter((held) => held !== buff) };
    }
    this.pendingStops.push({
      text,
      at,
      suspects: suspects.map((buff) => buff.spell)
    });
    // A list-size bound, not a knob: a sheet resolves these long before.
    if (this.pendingStops.length > 20) this.pendingStops.shift();
    return null;
  }

  /**
   * The `st` sheet is the authoritative listing of what is up.
   *
   * The server prints each active effect's own onset sentence at the foot of
   * the sheet — `You feel ferocious!`, `You are using pressure points!` —
   * and Paramud adds a countdown (`You feel safe from evil! (90s)`). Read
   * with the same rule every listing in this client follows: it establishes
   * the list and the broadcasts maintain it. A buff whose start sentence is
   * known and is not on the sheet has ended without a sentence this client
   * read, and goes; one whose start nobody knows cannot be judged and stays
   * for its clock. The sheet's own lines have already arrived as
   * `spell-onset` blocks and added whatever was missing, so this half only
   * removes and times.
   *
   * It is also where a pending ending is settled: a suspect the sheet still
   * lists was not ended by the sentence, and one suspect left that the sheet
   * has positively dropped is the buff the sentence ended.
   */
  private readSheet(s: CharacterState, text: string, at: number): ActiveBuff[] {
    const up = new Set<string>();
    const timers = new Map<string, number>();
    const printed: string[] = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.length === 0) continue;
      const timed = /^(?<line>.+?)\s*\((?<seconds>\d+)s\)$/.exec(line);
      const sentence = timed?.groups?.['line'] ?? line;
      const seconds = timed ? Number(timed.groups?.['seconds']) : null;
      const names = this.spellsBegunBy(sentence);
      // Only a line that accounted for nothing is a candidate effect: a
      // sentence the frames or the learned onset map already turned into a
      // buff is that buff being restated, not a second one.
      if (names.length === 0) printed.push(sentence);
      for (const name of names) {
        up.add(spellKey(name));
        if (seconds !== null && Number.isFinite(seconds)) {
          timers.set(spellKey(name), at + seconds * 1000);
        }
      }
    }
    // Before the keeping below, because it adds to `up`: an effect this sheet
    // has just named is one the same sheet must not then be read as dropping.
    const found = this.resolveEffects(printed, up, at);

    const kept: ActiveBuff[] = [];
    for (const buff of s.buffs) {
      const names = this.buffNames(buff);
      const listed = names.some((name) => up.has(spellKey(name)));
      if (!listed && this.knowsStart(buff)) continue;
      const expiresAt = names
        .map((name) => timers.get(spellKey(name)))
        .find((v) => v !== undefined);
      // The server's statement, so it overwrites any earlier `expiresAt`.
      kept.push(expiresAt === undefined ? { ...buff } : { ...buff, expiresAt });
    }
    this.settlePending(up, at);
    // A newly named effect that nothing on the list already covers. Appended
    // after the keeping so its own `appliedAt` is this sheet rather than the
    // sighting, which is the honest reading: when it landed is not known.
    for (const buff of found) {
      if (!kept.some((held) => this.buffMatches(held, [buff.spell]))) kept.push(buff);
    }
    return kept;
  }

  /**
   * What the sheet says about the sentences nothing could name.
   *
   * The sheet is the arbiter for both halves of the question, and it can be
   * because of one fact about the server: `StatCommand.cs:50` prints
   * `DescMessage.Line3` for **every** timed effect on the player, and that is
   * the same line the spell printed when it landed (`Spell.cs:1233`, `:1360`).
   * Hostile effects are not filtered out, and a sentence that was printed on
   * landing came from a non-empty `Line3`, so the sheet is bound to carry it
   * while it lasts.
   *
   * So: **a sentence the sheet prints is a lasting effect**, learned under
   * its own words (`unnamedEffect`) so that every rule this client already
   * has for a buff — the listing that drops what is gone, the ending learned
   * from the next unclaimed sentence, the duration — applies to it without
   * knowing which spell it is. And **a sentence the sheet leaves out is not
   * one**, which is the half that pays for the asking: `You are poisoned!`
   * answering a `rest` is refused once per realm rather than once a sighting.
   *
   * The wire's own order is what makes the negative safe: the server prints
   * the landing line before it renders a sheet asked for afterwards, so a
   * sheet that could have carried it and did not is a statement. The one gap
   * is an effect that *expired* in between, which is why a candidate older
   * than `tuning.spells.effectVerdictMs` is dropped unresolved instead — and
   * why the mistake is cheap either way: the next sheet that does carry the
   * sentence overwrites the verdict.
   */
  private resolveEffects(printed: readonly string[], up: Set<string>, at: number): ActiveBuff[] {
    const found: ActiveBuff[] = [];
    const seen = new Set<string>();
    for (const sentence of printed) {
      const key = effectKey(sentence);
      if (key.length === 0 || seen.has(key)) continue;
      seen.add(key);
      if (!looksLikeEffectSentence(sentence)) continue;
      const spell = unnamedEffect(sentence);
      this.spellLore.effects.lasting(sentence, 'yes', at);
      this.spellLore.learn(spell, 'start', sentence, at);
      up.add(spellKey(spell));
      found.push({ spell, by: null, appliedAt: at });
      /*
       * And it is not an ending. The same sentence may have been acted on as
       * the one buff whose stop nobody knew, or be waiting on a shortlist of
       * them — the sheet has just said it is an effect that is *up*, which is
       * the stronger statement, so both readings go.
       */
      for (const pending of this.pendingOnsets) {
        if (effectKey(pending.text) !== key || pending.stopFor === undefined) continue;
        this.spellLore.unlearn(pending.stopFor, 'stop');
      }
      this.pendingStops = this.pendingStops.filter((pending) => effectKey(pending.text) !== key);
    }

    const verdictMs = tuning().spells.effectVerdictMs;
    this.pendingOnsets = this.pendingOnsets.filter((pending) => {
      const key = effectKey(pending.text);
      if (seen.has(key)) return false;
      if (at - pending.at > verdictMs) return false;
      this.spellLore.effects.lasting(pending.text, 'no', at);
      return false;
    });
    return found;
  }

  /**
   * A sentence that may be an effect landing, held for the next sheet.
   *
   * Refused outright where this realm has already settled that the sentence
   * is no lasting effect: a listing is asked for when it would settle
   * something, and a question already answered settles nothing.
   */
  private suspectEffect(text: string, at: number): void {
    if (this.spellLore.effects.seen(text)?.lasting === 'no') return;
    const key = effectKey(text);
    if (key.length === 0) return;
    if (this.pendingOnsets.some((pending) => effectKey(pending.text) === key)) return;
    this.pendingOnsets.push({ text, at });
    // A list-size bound, not a knob, as the pending endings have.
    if (this.pendingOnsets.length > 20) this.pendingOnsets.shift();
    this.sheetWanted = true;
  }

  /**
   * What an effect nothing can name turns out to *do*.
   *
   * The client already reads this for a named spell, from the realm's own
   * data: the table pairs the spell's start sentence with its stop, and
   * `afflictionOnset` says which condition that sentence turns on — which is
   * how `You are blind!` wearing off clears the flag. An effect that has no
   * name has no row to read, so the only evidence is the coincidence, and
   * this is the whole of it:
   *
   * - a condition turns on, nothing named explains it, and an unnamed effect
   *   is up — **suspected**;
   * - the condition turns off in the same breath the effect ends —
   *   **confirmed**;
   * - the condition turns off while the effect is still up — the two are
   *   unrelated and the suspicion is **dropped**, not weakened.
   *
   * A suspicion is written down, so what it is built on can be read, and it
   * is never enough on its own to sit a character down or stand one up: that
   * is what the confirmed verdict is for. The realm keeps both
   * (`RealmLore.ledgerFor`), because what a monster's spell does is a fact
   * about the world and not about who it landed on.
   */
  deduceCauses(before: CharacterState, after: CharacterState, at: number): void {
    // Nothing to read off a block that moved neither. Reference equality, as
    // the player fold's gate is: the reducer hands back the same list when it
    // changed nothing, and a status line arrives several times a second.
    if (after.afflictions === before.afflictions && after.buffs === before.buffs) return;
    const ledger = this.spellLore.effects;
    const window = tuning().spells.effectCauseMs;
    const unnamed = (buffs: readonly ActiveBuff[]): string[] =>
      buffs
        .map((buff) => unnamedEffectSentence(buff.spell))
        .filter((sentence): sentence is string => sentence !== null);
    const up = unnamed(after.buffs);

    for (const condition of AFFLICTIONS) {
      const was = before.afflictions[condition];
      const now = after.afflictions[condition];
      if (was === now) continue;
      if (now === 'yes') {
        if (up.length === 0 || this.namedCause(after, condition)) continue;
        for (const sentence of up) {
          // A verdict is reached once. Re-suspecting what the wire already
          // confirmed would walk a finding backwards on every recurrence.
          if (ledger.seen(sentence)?.causes?.[condition] === 'confirmed') continue;
          ledger.causes(sentence, condition, 'suspected');
        }
        continue;
      }
      if (now !== 'no') continue;
      // Still up while the condition has gone: whatever this effect does, it
      // is not that.
      for (const sentence of up) {
        if (ledger.seen(sentence)?.causes?.[condition] === undefined) continue;
        ledger.causes(sentence, condition, null);
      }
      this.conditionEnded.set(condition, at);
      for (const [sentence, ended] of this.effectEnded) {
        if (at - ended <= window) this.confirmCause(sentence, condition);
      }
    }

    /*
     * And the other order. The effect's own ending and the condition's are two
     * sentences, and which the server writes first is its business — so each
     * is recorded as it happens and each looks for the other. Both maps are
     * bounded by the buff list and the four conditions.
     */
    for (const sentence of unnamed(before.buffs)) {
      if (up.includes(sentence)) continue;
      this.effectEnded.set(sentence, at);
      // A list-size bound, not a knob: the window is five seconds and the
      // oldest entry is the least useful.
      if (this.effectEnded.size > 20) {
        const oldest = this.effectEnded.keys().next().value;
        if (oldest !== undefined) this.effectEnded.delete(oldest);
      }
      for (const [condition, ended] of this.conditionEnded) {
        if (at - ended <= window) this.confirmCause(sentence, condition);
      }
    }
  }

  /** A suspicion the wire has now shown twice over. Never a promotion of nothing. */
  private confirmCause(sentence: string, condition: keyof Afflictions): void {
    const ledger = this.spellLore.effects;
    if (ledger.seen(sentence)?.causes?.[condition] !== 'suspected') return;
    ledger.causes(sentence, condition, 'confirmed');
  }

  /**
   * Which conditions a spell turns on, and so which its ending turns off.
   *
   * Three sources, in order of authority, and none of them a guess:
   *
   * 1. **The realm's own ability row** for the hold family — `HoldPerson`
   *    (74), the one ability `ActionFigure.CheckForHoldPerson` tests.
   * 2. **The shipped message table's pairing**: the spell's start sentence,
   *    which `afflictionOnset` recognises for blindness, poison, disease and
   *    the two holds fixed in the server's code.
   * 3. **What this realm worked out**, and only where it was *confirmed* —
   *    the condition ended in the same breath as the effect, observed, not
   *    inferred (`deduceCauses`). A suspicion never reaches here: it is
   *    written down to be read, not acted on.
   *
   * The third makes the ending self-fulfilling from then on, which is worth
   * stating plainly: once confirmed, this clears the condition, so the
   * coincidence that confirmed it will recur. It cannot *strengthen* anything
   * false — a verdict is confirmed once, from evidence gathered before
   * anything acted on it — and the retraction that answers a false one fires
   * on the other transition, the condition ending while the effect is still
   * up, which this does not touch.
   */
  private conditionsOf(name: string): Array<keyof Afflictions> {
    const sentence = unnamedEffectSentence(name);
    if (sentence !== null) {
      const causes = this.spellLore.effects.seen(sentence)?.causes ?? {};
      return AFFLICTIONS.filter((condition) => causes[condition] === 'confirmed');
    }
    const conditions: Array<keyof Afflictions> = [];
    const row = this.world?.spellNamed(name);
    if (holdsMovement(row)) conditions.push('held');
    if (confuses(row)) conditions.push('confused');
    const start = this.spellLore.startOf(name);
    const stated = start === null ? null : afflictionOnset(start);
    if (stated !== null && !conditions.includes(stated)) conditions.push(stated);
    return conditions;
  }

  /**
   * Whether a spell that is up and *has* a name is known to cause a
   * condition — so a condition it explains teaches an unnamed effect nothing.
   *
   * Read exactly as the wear-off reads it: the realm's `HoldPerson` row for
   * the hold family, and for the rest the table's own pairing of the spell
   * with the sentence `afflictionOnset` recognises.
   */
  private namedCause(s: CharacterState, condition: keyof Afflictions): boolean {
    return s.buffs.some((buff) =>
      this.buffNames(buff).some(
        (name) => !isUnnamedEffect(name) && this.conditionsOf(name).includes(condition)
      )
    );
  }

  /** The sentence was read as this buff's ending; a sheet can take that back. */
  private actedAsStop(text: string, spell: string): void {
    const key = effectKey(text);
    const pending = this.pendingOnsets.find((held) => effectKey(held.text) === key);
    if (pending) pending.stopFor = spell;
  }

  /** Every spell a sheet line says is up: the table's starts, then the learned onset map. */
  private spellsBegunBy(sentence: string): string[] {
    const hit = this.spellLore.match(sentence);
    const names =
      hit !== null && hit.starts.length > 0 && hit.stops.length === 0 ? [...hit.starts] : [];
    const effect = /^You feel (?<effect>[\w' -]+?)!$/.exec(sentence)?.groups?.['effect'];
    const learned = effect ? this.buffEffects.get(effect.trim().toLowerCase()) : undefined;
    if (learned !== undefined && !names.some((name) => this.namesOneSpell(name, learned))) {
      names.push(learned);
    }
    return names;
  }

  private settlePending(up: ReadonlySet<string>, at: number): void {
    this.pendingStops = this.pendingStops.filter((pending) => {
      if (at - pending.at > tuning().spells.pendingStopMs) return false;
      pending.suspects = pending.suspects.filter((name) => !up.has(spellKey(name)));
      if (pending.suspects.length === 0) return false;
      if (pending.suspects.length > 1) return true;
      const name = pending.suspects[0]!;
      // Learned only on a positive statement: the sheet knows this buff's
      // start and has stopped printing it. A buff the sheet cannot speak
      // about keeps the sentence waiting.
      if (this.spellLore.startOf(name) === null) return true;
      this.spellLore.learn(name, 'stop', pending.text, pending.at);
      return false;
    });
  }

  /**
   * A buff established with no cast in front of it, right after a learned
   * ending removed the same buff, is the wire saying the ending was wrong.
   * A recast comes in through its own cast frame and never reaches here.
   */
  private noteContradiction(names: readonly string[], at: number): void {
    for (const name of names) {
      const stoppedAt = this.recentlyStopped.get(spellKey(name));
      if (stoppedAt === undefined) continue;
      this.recentlyStopped.delete(spellKey(name));
      if (at - stoppedAt <= tuning().spells.stopContradictionMs) {
        this.spellLore.unlearn(name, 'stop');
      }
    }
  }

  /**
   * Buffs that have ended. A cast confirmation and its ending are a measured
   * duration — the only statement of one this client trusts, the realm's
   * `Dur` column being in units nothing on hand establishes — but only where
   * the ending was *recognised*: a sentence learned this instant is a
   * conclusion, and a duration measured from it would be one too. Own casts
   * only: a party member's duration scales with their level. The pending
   * endings drop these as suspects, because whatever ended them was not the
   * sentence nothing recognised.
   */
  private buffsEnded(ended: readonly ActiveBuff[], at: number, recognised: boolean): void {
    for (const buff of ended) {
      if (recognised && buff.by === null) {
        const seconds = (at - buff.appliedAt) / 1000;
        if (seconds > 0) this.sources.belongings().rememberSpellDuration(buff.spell, seconds);
      }
      const names = this.buffNames(buff);
      for (const pending of this.pendingStops) {
        pending.suspects = pending.suspects.filter(
          (name) => !names.some((held) => this.namesOneSpell(held, name))
        );
      }
    }
    this.pendingStops = this.pendingStops.filter((pending) => pending.suspects.length > 0);
  }

  /**
   * A spell onset that stands the character still, and the move it refused.
   *
   * **The realm states which spells hold and the server states what that
   * does**, so neither is guessed here. `holdsMovement` is the ability row
   * (`HoldPerson`, 74) that `ActionFigure.CheckForHoldPerson` tests, and 60 of
   * the shipped realm's spells carry it: `knockdown`, `entangle`, `thick
   * webbing`, `freeze`, `gust of wind`, `chain`, `roar` and the rest. Their
   * onset sentences are the realm's message data — `You are flat on your
   * back!`, `You are caught in a chain!` — twenty distinct ones, which is
   * twenty patterns `patterns.ts` would have had to carry and keep in step
   * with every realm it is pointed at. Two sentences are fixed in the
   * server's *code* and stay there (`Your legs are paralyzed!`, `You are
   * held!`).
   *
   * **The same sentence is printed twice over**, which is what makes the move
   * worth consuming: once when the effect lands, and again by
   * `CheckForHoldPerson` every time a held character tries to walk — the
   * refusal the player sees as `[HP …]: ne` answered by `You are flat on your
   * back!` and nothing else. `Exits.Move` returns there before anybody moves,
   * so no room is coming, and `shiftHeldMove` is what keeps that step from
   * sitting in the queue gating the escape, the walk, the lap and retaliation
   * until it goes stale — the failure the toll refusal and `You are blind.`
   * have both already shipped once each.
   *
   * Only a move at the head is taken, never whatever is there: the landing
   * print refuses nothing, and a `look` waiting at the head is answering its
   * own command. Null when nothing here holds, or when the flag already says
   * so.
   */
  private heldByOnset(s: CharacterState, candidates: readonly string[]): CharacterState | null {
    const rows = candidates.map((name) => this.world?.spellNamed(name));
    let next: CharacterState | null = null;
    if (rows.some(holdsMovement)) {
      this.expect.shiftHeldMove();
      next = afflicted(s, 'held', 'yes');
    }
    // A confusion landing refuses nothing by itself — the fumbles come later,
    // one command at a time — so the flag is set and no claim is taken.
    if (rows.some(confuses)) next = afflicted(next ?? s, 'confused', 'yes') ?? next;
    return next;
  }

  private withBuff(s: CharacterState, buff: ActiveBuff): CharacterState {
    const kept = s.buffs.filter((held) => !this.buffMatches(held, this.buffNames(buff)));
    return { ...s, buffs: [...kept.slice(-KEPT_BUFFS), buff] };
  }

  /** The spell and every other it might be. */
  private buffNames(buff: ActiveBuff): string[] {
    return [buff.spell, ...(buff.candidates ?? [])];
  }

  private buffMatches(buff: ActiveBuff, names: readonly string[]): boolean {
    return this.buffNames(buff).some((held) =>
      names.some((name) => this.namesOneSpell(held, name))
    );
  }

  /**
   * Whether two spellings name one spell — exactly, or through the realm's
   * spell table so its two spellings of one row (name and abbreviation)
   * cannot make one buff two.
   */
  private namesOneSpell(a: string, b: string): boolean {
    if (spellKey(a) === spellKey(b)) return true;
    const rowA = this.world?.spellNamed(a) ?? null;
    const rowB = this.world?.spellNamed(b) ?? null;
    return rowA !== null && rowB !== null && rowA.id === rowB.id;
  }

  private knowsStart(buff: ActiveBuff): boolean {
    return this.buffNames(buff).some(
      (name) =>
        this.spellLore.startOf(name) !== null ||
        [...this.buffEffects.values()].some((learned) => this.namesOneSpell(learned, name))
    );
  }

  private knowsStop(buff: ActiveBuff): boolean {
    return this.buffNames(buff).some((name) => this.spellLore.stopOf(name) !== null);
  }

  /** Whether this character's own listing says it can cast the spell. */
  private knowsSpell(s: CharacterState, name: string): boolean {
    return (s.spellbook ?? []).some(
      (known) =>
        this.namesOneSpell(known.name, name) ||
        (known.short !== null && spellKey(known.short) === spellKey(name))
    );
  }

  /** Whether a sentence names this character, anybody in the room or anybody in the party. */
  private namesSomebody(s: CharacterState, text: string): boolean {
    const names = [
      s.name,
      ...s.room.occupants.map((who) => who.name),
      ...s.party.members.map((member) => member.name)
    ];
    const lower = text.toLowerCase();
    return names.some((name) => {
      if (name === null || name.trim().length === 0) return false;
      const needle = name.trim().toLowerCase();
      const at = lower.indexOf(needle);
      if (at < 0) return false;
      const before = at === 0 ? ' ' : lower[at - 1]!;
      const after = lower[at + needle.length] ?? ' ';
      return !/[a-z0-9']/.test(before) && !/[a-z0-9]/.test(after);
    });
  }
}
