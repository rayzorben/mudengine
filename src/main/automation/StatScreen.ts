/**
 * Spending character points on the `train stats` screen (todo 10,
 * 2026-09-12) — the one thing exempt from the queue's hold, because it is the
 * one thing that understands the form the hold exists to protect.
 *
 * The screen is driven by *reading* it: the dump gives every stat's base,
 * ceiling and figure and the CP left; each keystroke's echo names the field
 * that took focus and its value, so a value the server refused is seen where
 * it happened, never counted past. The name fields are never typed into,
 * SAVE is the only way out, and every purchase, refusal and stop is said.
 * See `mudengine-automation` § *Character points are spent on the stat
 * screen, under a switch*.
 */
import type { CommandQueue } from './CommandQueue';
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { SafetyDecision } from '../../shared/automation';
import { isPrompt, type Block } from '../../shared/blocks';
import type { CharacterState } from '../../shared/character';
import { opensStatScreen } from '../../shared/commands';
import type { TrainConfig } from '../../shared/config';
import {
  planTraining,
  raiseCost,
  wantsMore,
  TRAINED_ATTRIBUTES,
  type Purchase,
  type StatLimits,
  type TrainedAttribute,
  type TrainingPlan
} from '../../shared/training';

export interface StatScreenPlanner {
  /** Whether the room the character stands in is a trainer's. */
  atTrainer(): boolean;
  /** Bytes straight to the wire, past the held queue: the one exemption. */
  write(bytes: string): void;
}

export interface StatScreenEvents {
  notice?(message: string): void;
  decided?(decision: SafetyDecision): void;
}

/**
 * The form as `AssignStatsState.Init` builds it for an existing character
 * (`train stats` sets `TrainStats`, never `TrainStatsWithNameChange`, so the
 * given name is drawn but not in the menu). Widths are the field
 * definitions' `MaxLength`: `LAST_NAME_MAXLENGTH` 10, the six stats 4, the
 * three toggles 15, the exit toggle 4 — and the live echo of a bare Enter on
 * the family name was exactly 28 characters, `10 + 4 + 10 + 4`.
 */
type FieldId =
  'lastName' | TrainedAttribute | 'hairLength' | 'hairColour' | 'eyeColour' | 'exitSave';
interface Field {
  id: FieldId;
  width: number;
}
const FIELDS: readonly Field[] = [
  { id: 'lastName', width: 10 },
  { id: 'strength', width: 4 },
  { id: 'intellect', width: 4 },
  { id: 'willpower', width: 4 },
  { id: 'agility', width: 4 },
  { id: 'health', width: 4 },
  { id: 'charm', width: 4 },
  { id: 'hairLength', width: 15 },
  { id: 'hairColour', width: 15 },
  { id: 'eyeColour', width: 15 },
  { id: 'exitSave', width: 4 }
];
const NAME_WIDTH = 10;
const RACE_WIDTH = 18;
const CP_WIDTH = 4;
const ENTER = '\r\n';
const SPACE = ' ';
const ACTION = 'train stats';
const COALESCE = 'train:stats';

function isAttribute(id: FieldId): id is TrainedAttribute {
  return (TRAINED_ATTRIBUTES as readonly string[]).includes(id);
}

/** What the dump says, once the whole of it has arrived. */
export interface ScreenReading {
  firstName: string;
  lastName: string;
  /** The value the first focused field was drawn with, after the dump. */
  focused: string;
  limits: Record<TrainedAttribute, StatLimits>;
  current: Record<TrainedAttribute, number>;
  cp: number;
  exit: string;
}

const LIMIT = /\(\s*(\d+) to\s+(\d+)\)/g;

/**
 * `ShowMenu`: the static text, then `({Base,4} to {Max,4})` six times, then
 * `ShowCurrentValues` — given name, the menu's fields in order, race, class,
 * CP left — and then `Focus(0)` redraws the first field. Null until the
 * values have arrived; the dump is one flush on the wire but the reading
 * does not depend on that.
 */
export function readScreen(text: string): ScreenReading | null {
  const limits: Array<[number, number]> = [];
  let end = -1;
  LIMIT.lastIndex = 0;
  for (let match = LIMIT.exec(text); match !== null; match = LIMIT.exec(text)) {
    limits.push([Number(match[1]), Number(match[2])]);
    end = match.index + match[0].length;
  }
  if (limits.length < 6 || end < 0) return null;
  const six = limits.slice(-6);
  const values = text.slice(end);
  const fixed =
    NAME_WIDTH +
    FIELDS.reduce((total, field) => total + field.width, 0) +
    RACE_WIDTH * 2 +
    CP_WIDTH;
  if (values.length < fixed) return null;
  const padded = values.padEnd(fixed + NAME_WIDTH, ' ');

  let at = 0;
  const take = (width: number): string => {
    const slice = padded.slice(at, at + width);
    at += width;
    return slice.trim();
  };
  const firstName = take(NAME_WIDTH);
  const lastName = take(FIELDS[0]!.width);
  const current = {} as Record<TrainedAttribute, number>;
  for (const attribute of TRAINED_ATTRIBUTES) {
    const figure = Number(take(4));
    if (!Number.isInteger(figure)) return null;
    current[attribute] = figure;
  }
  take(15);
  take(15);
  take(15);
  const exit = take(4);
  take(RACE_WIDTH);
  take(RACE_WIDTH);
  const cp = Number(take(CP_WIDTH));
  if (!Number.isInteger(cp)) return null;
  const focused = padded.slice(at).trim();

  const record = {} as Record<TrainedAttribute, StatLimits>;
  TRAINED_ATTRIBUTES.forEach((attribute, index) => {
    const [base, max] = six[index]!;
    record[attribute] = { base, max };
  });
  return { firstName, lastName, focused, limits: record, current, cp, exit };
}

/**
 * The server's three refusals (`StatField.Validate`), printed at row 23
 * ahead of the field being refocused with its old value.
 */
const REFUSAL =
  /^(You may not assign that much to \w+|\w+ may not be (?:lower|higher) than \d+\.|Invalid number\.)/;
export function readRefusal(text: string): string | null {
  return REFUSAL.exec(text)?.[1] ?? null;
}

export interface Advance {
  previous: string;
  cp: number;
  next: string;
}

/**
 * The echo of an accepted Enter on field `from`: the field redrawn, the CP
 * left, the field redrawn again (`FocusNext` does), then the next field
 * drawn focused. Null while too little has arrived to read the next field
 * whole — a stat is right-justified so its last digit closes the echo; the
 * exit toggle is one of its two words or not yet there.
 */
export function readAdvance(text: string, from: number): Advance | null {
  const field = FIELDS[from];
  const next = FIELDS[from + 1];
  if (!field || !next) return null;
  const head = field.width * 2 + CP_WIDTH;
  const value = text.slice(head).trimEnd();
  if (next.id === 'exitSave') {
    if (value !== 'SAVE' && value !== 'QUIT') return null;
  } else if (isAttribute(next.id)) {
    if (text.length < head + next.width) return null;
  } else if (value.length === 0) {
    return null;
  }
  const cp = Number(text.slice(field.width, field.width + CP_WIDTH).trim());
  if (!Number.isInteger(cp)) return null;
  return { previous: text.slice(0, field.width).trim(), cp, next: value.trim() };
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'asked' }
  | { kind: 'reading'; text: string }
  | {
      kind: 'driving';
      /** What the dump said each stat was, which every echo is checked against. */
      shown: Record<TrainedAttribute, number>;
      limits: Record<TrainedAttribute, StatLimits>;
      /** Where each stat is to end up; pulled back to `shown` when buying stops. */
      targets: Record<TrainedAttribute, number>;
      /** The field that has focus. */
      field: number;
      await: 'advance' | 'typed' | 'toggle' | 'saved';
      echo: string;
      /** What was typed into the focused field, while `typed` is awaited. */
      typed: string;
      /** Purchases the server has accepted, field by field. */
      bought: Purchase[];
      cpLeft: number;
      /** Why buying stopped early, or null. Buying stopped still saves. */
      stopped: string | null;
    };

export class StatScreen {
  private phase: Phase = { kind: 'idle' };
  /** The `train stats` this proposed and has not yet seen answered. */
  private proposed = false;
  /** The last situation acted on or declined, so one situation is one attempt and one sentence. */
  private handled: string | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private config: TrainConfig,
    private enabled: boolean,
    private readonly queue: CommandQueue,
    private readonly planner: StatScreenPlanner,
    private readonly events: StatScreenEvents = {}
  ) {}

  configure(config: TrainConfig, enabled: boolean): void {
    this.config = config;
    this.enabled = enabled;
  }

  reset(): void {
    this.disarm();
    this.phase = { kind: 'idle' };
    this.proposed = false;
    this.handled = null;
  }

  dispose(): void {
    this.reset();
  }

  /** Whether the screen up now is this driver's to drive. */
  get driving(): boolean {
    return this.phase.kind === 'reading' || this.phase.kind === 'driving';
  }

  /**
   * A `train stats` left the client. From the arbiter and proposed here, the
   * screen coming is this driver's; typed by the player, it is theirs and
   * nothing here touches it — and a proposal still queued is withdrawn.
   */
  noteSent(command: string, origin: 'user' | 'automation'): void {
    if (!opensStatScreen(command)) return;
    if (origin === 'automation' && this.proposed) {
      this.proposed = false;
      this.phase = { kind: 'asked' };
      return;
    }
    this.proposed = false;
    this.queue.cancel((intent) => intent.coalesceKey === COALESCE);
    this.disarm();
    this.phase = { kind: 'idle' };
  }

  onCharacter(state: CharacterState): void {
    if (!this.enabled || !this.config.stats || state.phase !== 'in-game') return;
    if (this.phase.kind !== 'idle' || this.proposed) return;
    const cp = state.progress.cp;
    if (cp === null || cp <= 0) return;
    if (!this.planner.atTrainer()) return;

    const current: Partial<Record<TrainedAttribute, number | null>> = {};
    for (const attribute of TRAINED_ATTRIBUTES) current[attribute] = state.progress[attribute];
    const key = [
      cp,
      state.room.map,
      state.room.number,
      ...TRAINED_ATTRIBUTES.map(
        (attribute) => `${current[attribute] ?? '?'}>${this.config.wanted[attribute]}`
      )
    ].join('|');
    if (this.handled === key) return;
    this.handled = key;

    if (!wantsMore(this.config.wanted, current)) {
      this.events.notice?.(
        t('automation.train.nothingWanted', { cp, figures: this.figures(current) })
      );
      this.decide(false, t('automation.train.whyNothingWanted'), cp);
      return;
    }
    /*
     * Priced from the sheet where the realm's race spans allow, so a screen
     * that would be opened only to be left is not opened. The screen's own
     * figures are the ones bought on; this is a forecast.
     */
    const forecast = this.forecast(state, cp);
    if (forecast !== null && forecast.purchases.length === 0) {
      const dearest = forecast.unaffordable[0];
      if (dearest) {
        this.events.notice?.(
          t('automation.train.nothingAffordable', {
            cp,
            attribute: attributeWord(dearest.attribute),
            cost: dearest.nextCost
          })
        );
        this.decide(
          false,
          t('automation.train.whyUnaffordable', { cost: dearest.nextCost, left: cp }),
          cp
        );
      }
      return;
    }

    this.proposed = this.queue.enqueue({
      command: ACTION,
      priority: 'probe',
      coalesceKey: COALESCE,
      expiresAt: Date.now() + tuning().train.expiresMs,
      reason: t('automation.train.reason', { cp })
    });
  }

  onBlock(block: Block): void {
    switch (this.phase.kind) {
      case 'idle':
        return;
      case 'asked':
        if (block.type === 'user-stats-screen') {
          this.phase = { kind: 'reading', text: block.text };
          this.arm();
          this.tryRead();
        } else if (isPrompt(block.type)) {
          // Answered with a prompt and no screen: the realm refused the word.
          this.phase = { kind: 'idle' };
        }
        return;
      case 'reading':
        if (block.type === 'unknown') {
          this.phase.text += block.text;
          this.tryRead();
        }
        return;
      case 'driving':
        if (block.type === 'user-stats-assigned') {
          this.finish();
          return;
        }
        if (block.type === 'unknown') {
          this.phase.echo += block.text;
          this.step();
        }
        return;
    }
  }

  private tryRead(): void {
    if (this.phase.kind !== 'reading') return;
    const reading = readScreen(this.phase.text);
    if (reading === null) return;
    this.disarm();
    /*
     * The first field focused must be the family name — blank or the name
     * itself. A screen that focuses the given name is the name-change form,
     * whose first field is one this driver must never so much as Enter past.
     */
    const nameUp = reading.firstName.length > 0 && reading.focused === reading.firstName;
    if (nameUp || reading.focused !== reading.lastName) {
      this.events.notice?.(t('automation.train.notName'));
      this.decide(false, t('automation.train.whyNotName'), reading.cp);
      this.phase = { kind: 'idle' };
      return;
    }
    const plan = planTraining({
      current: reading.current,
      wanted: this.config.wanted,
      limits: reading.limits,
      cp: reading.cp
    });
    if (plan.capped.length > 0) {
      this.events.notice?.(
        t('automation.train.capped', { attributes: plan.capped.map(attributeWord).join(', ') })
      );
    }
    if (plan.purchases.length === 0) {
      const dearest = plan.unaffordable[0];
      this.events.notice?.(
        t('automation.train.leaving', {
          why: dearest
            ? t('automation.train.whyUnaffordable', { cost: dearest.nextCost, left: plan.left })
            : t('automation.train.whyNothingWanted')
        })
      );
    } else {
      this.events.notice?.(
        t('automation.train.opening', {
          spent: plan.spent,
          cp: reading.cp,
          purchases: this.purchases(plan.purchases)
        })
      );
    }
    this.phase = {
      kind: 'driving',
      shown: { ...reading.current },
      limits: reading.limits,
      targets: { ...plan.targets },
      field: 0,
      await: 'advance',
      echo: '',
      typed: '',
      bought: [],
      cpLeft: reading.cp,
      stopped: null
    };
    // Field 0 is the family name: one Enter past it, unchanged, never a key into it.
    this.send(ENTER);
  }

  /** An echo arrived while driving: read it against what was awaited. */
  private step(): void {
    const phase = this.phase;
    if (phase.kind !== 'driving') return;
    const field = FIELDS[phase.field]!;

    if (phase.await === 'typed') {
      const expected = SPACE.repeat(field.width) + phase.typed;
      if (phase.echo.length < expected.length) return;
      if (phase.echo !== expected) {
        // Whatever the field holds now, the server's own validation decides it.
        this.stop(
          t('automation.train.echoed', { attribute: attributeWord(field.id as TrainedAttribute) })
        );
      }
      phase.echo = '';
      phase.await = 'advance';
      this.send(ENTER);
      return;
    }

    if (phase.await === 'toggle') {
      if (phase.echo.trimEnd().length < 4) return;
      if (phase.echo.trimEnd() !== 'SAVE') {
        this.stop(t('automation.train.echoed', { attribute: 'Exit' }));
        this.letGo();
        return;
      }
      phase.echo = '';
      phase.await = 'saved';
      this.send(ENTER);
      return;
    }

    if (phase.await !== 'advance') return;

    const refusal = readRefusal(phase.echo);
    if (refusal !== null) {
      /*
       * The field is refocused holding its old value; an Enter on it costs
       * nothing and advances. What was typed is not bought, and nothing after
       * it is tried — a plan the server disagreed with once is not a plan.
       */
      this.stop(t('automation.train.refused', { sentence: refusal }));
      if (isAttribute(field.id)) phase.targets[field.id] = phase.shown[field.id];
      phase.echo = '';
      this.send(ENTER);
      return;
    }

    const advance = readAdvance(phase.echo, phase.field);
    if (advance === null) return;
    phase.echo = '';
    phase.cpLeft = advance.cp;
    if (isAttribute(field.id) && phase.targets[field.id] !== phase.shown[field.id]) {
      const from = phase.shown[field.id];
      const to = phase.targets[field.id];
      phase.bought.push({
        attribute: field.id,
        from,
        to,
        cost: raiseCost(phase.limits[field.id].base, from, to)
      });
    }

    phase.field += 1;
    const next = FIELDS[phase.field]!;
    if (next.id === 'exitSave') {
      if (advance.next === 'QUIT') {
        phase.await = 'toggle';
        this.send(SPACE);
        return;
      }
      phase.await = 'saved';
      this.send(ENTER);
      return;
    }
    if (isAttribute(next.id)) {
      const shown = Number(advance.next);
      const expected = phase.shown[next.id];
      if (shown !== expected) {
        this.stop(
          t('automation.train.desync', {
            attribute: attributeWord(next.id),
            shown: advance.next,
            expected
          })
        );
        phase.shown[next.id] = shown;
      }
      const target = phase.stopped === null ? phase.targets[next.id] : shown;
      phase.targets[next.id] = target;
      if (target !== shown) {
        phase.typed = String(target);
        phase.await = 'typed';
        this.send(phase.typed);
        return;
      }
    }
    phase.await = 'advance';
    this.send(ENTER);
  }

  /** `SAVE` went through: the server printed the sentence it prints on nothing else. */
  private finish(): void {
    const phase = this.phase;
    if (phase.kind !== 'driving') return;
    this.disarm();
    const left = phase.cpLeft;
    if (phase.bought.length === 0) {
      this.events.notice?.(t('automation.train.savedNothing', { left }));
      this.decide(false, phase.stopped ?? t('automation.train.whyNothingWanted'), left);
    } else {
      this.events.notice?.(
        t('automation.train.saved', { purchases: this.purchases(phase.bought), left })
      );
      this.decide(
        true,
        t('automation.train.because', { spent: phase.bought.reduce((sum, p) => sum + p.cost, 0) }),
        left
      );
    }
    this.phase = { kind: 'idle' };
  }

  /** Nothing more is bought this visit; the walk to SAVE goes on. */
  private stop(why: string): void {
    if (this.phase.kind !== 'driving' || this.phase.stopped !== null) return;
    this.phase.stopped = why;
    this.events.notice?.(why);
  }

  /** The screen did not answer, or answered with something unreadable: the keyboard is the player's. */
  private letGo(): void {
    this.disarm();
    const cp = this.phase.kind === 'driving' ? this.phase.cpLeft : null;
    this.events.notice?.(
      t('automation.train.lapsed', { seconds: Math.round(tuning().train.echoMs / 1000) })
    );
    this.decide(false, t('automation.train.whyLapsed'), cp);
    this.phase = { kind: 'idle' };
  }

  private send(bytes: string): void {
    this.planner.write(bytes);
    this.arm();
  }

  private arm(): void {
    this.disarm();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.letGo();
    }, tuning().train.echoMs);
  }

  private disarm(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private decide(acted: boolean, because: string, cp: number | null): void {
    this.events.decided?.({
      at: Date.now(),
      action: ACTION,
      because: cp === null ? because : t('automation.train.cpLeft', { cp, because }),
      acted,
      ...(acted ? {} : { refused: because })
    });
  }

  private forecast(state: CharacterState, cp: number): TrainingPlan | null {
    const spans = state.attributeSpans;
    if (spans === null) return null;
    const current = {} as Record<TrainedAttribute, number>;
    const limits = {} as Record<TrainedAttribute, StatLimits>;
    for (const attribute of TRAINED_ATTRIBUTES) {
      const figure = state.progress[attribute];
      const span = spans[attribute];
      if (figure === null || span === undefined) return null;
      current[attribute] = figure;
      limits[attribute] = { base: span[0], max: span[1] };
    }
    return planTraining({ current, wanted: this.config.wanted, limits, cp });
  }

  private figures(current: Partial<Record<TrainedAttribute, number | null>>): string {
    return TRAINED_ATTRIBUTES.filter((attribute) => this.config.wanted[attribute] > 0)
      .map(
        (attribute) =>
          `${attributeWord(attribute)} ${current[attribute] ?? '?'}/${this.config.wanted[attribute]}`
      )
      .join(', ');
  }

  private purchases(list: readonly Purchase[]): string {
    return list
      .map((p) =>
        t('automation.train.purchase', {
          attribute: attributeWord(p.attribute),
          from: p.from,
          to: p.to,
          cost: p.cost
        })
      )
      .join(', ');
  }
}

/** Six literal keys rather than one composed, so `i18n-coverage.test.ts` can read them. */
export function attributeWord(attribute: TrainedAttribute): string {
  switch (attribute) {
    case 'strength':
      return t('automation.train.attribute.strength');
    case 'intellect':
      return t('automation.train.attribute.intellect');
    case 'willpower':
      return t('automation.train.attribute.willpower');
    case 'agility':
      return t('automation.train.attribute.agility');
    case 'health':
      return t('automation.train.attribute.health');
    case 'charm':
      return t('automation.train.attribute.charm');
  }
}
