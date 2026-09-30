/**
 * Finding a setting by its words: which sections, fieldsets and fields of the
 * settings form answer a query. `mudengine-settings` › *Find a setting*.
 *
 * The form is read as drawn rather than from a table of labels, because the
 * labels, legends and hints exist only in the JSX that draws them; a second
 * list would drift from the first on the next field anybody adds.
 */
import { matches, terms } from './table';

/**
 * One child of a section, as the search sees it.
 *
 * - `group` is a fieldset: shown whole or not at all, since its lists and
 *   disclosures only make sense together.
 * - `row` is fields standing outside a fieldset: each is shown by itself.
 * - `other` is anything else, a note or a list, shown when its words match.
 * - `nest` holds fieldsets without being one, as `Advanced` does: each child
 *   is judged as a unit of its own, and the rest of it shows with them.
 */
export type UnitText =
  | {
      kind: 'group' | 'row' | 'other';
      text: string;
      /** Each field's own words, in document order. */
      fields: readonly string[];
    }
  | { kind: 'nest'; units: readonly UnitText[] };

/** `hit` is a field the query named, which the form marks. */
export type FieldVerdict = 'hit' | 'shown' | 'hidden';

export interface UnitVerdict {
  shown: boolean;
  fields: readonly FieldVerdict[];
  /** A nest's children, in order; empty for any other unit. */
  units: readonly UnitVerdict[];
}

export interface SectionVerdict {
  shown: boolean;
  units: readonly UnitVerdict[];
}

/** The query has words in it, so the form is being searched. */
export function searches(query: string): boolean {
  return terms(query).length > 0;
}

/**
 * What of one section answers the query.
 *
 * A section whose own name matches is shown whole, and so is a fieldset whose
 * words match anywhere in it (legend, label or hint). Inside a shown fieldset
 * the matching fields are marked rather than the rest hidden.
 */
export function judgeSection(
  label: string,
  units: readonly UnitText[],
  query: string
): SectionVerdict {
  const whole = matches(query, [label]);
  const judged = units.map((unit) => judgeUnit(unit, whole, query));
  return { shown: whole || judged.some((unit) => unit.shown), units: judged };
}

function judgeUnit(unit: UnitText, whole: boolean, query: string): UnitVerdict {
  if (unit.kind === 'nest') {
    // A nest's own words (the Advanced toggle's) name everything in it.
    const named = unit.units.some(
      (inner) => inner.kind === 'other' && matches(query, [inner.text])
    );
    const inner = unit.units.map((child) => judgeUnit(child, whole || named, query));
    const shown = inner.some((child) => child.shown);
    return {
      shown,
      fields: [],
      units: inner.map((child, index) =>
        shown && unit.units[index]!.kind === 'other' ? { ...child, shown: true } : child
      )
    };
  }
  const named = unit.fields.map((field) => matches(query, [field]));
  if (unit.kind === 'row') {
    const fields = named.map((hit): FieldVerdict => (hit ? 'hit' : whole ? 'shown' : 'hidden'));
    return { shown: fields.some((field) => field !== 'hidden'), fields, units: [] };
  }
  return {
    shown: whole || matches(query, [unit.text]),
    fields: named.map((hit): FieldVerdict => (hit ? 'hit' : 'shown')),
    units: []
  };
}

/** The attribute each result is written to, and read by `index.css`. */
const MARK = 'data-search';

/**
 * Judges every `.settings-section` of the form and marks what it hides and
 * what it names. Returns the ids of the sections shown, in document order.
 */
export function applySettingsSearch(form: Element, query: string): string[] {
  const found: string[] = [];
  for (const section of form.querySelectorAll<HTMLElement>(':scope > .settings-section')) {
    const children = Array.from(section.children).filter(
      (child) => !child.classList.contains('settings-section-heading')
    );
    const read = children.map(readUnit);
    const verdict = judgeSection(section.dataset.label ?? '', read, query);
    mark(section, verdict.shown ? null : 'miss');
    children.forEach((child, index) => writeUnit(child, verdict.units[index]!));
    if (verdict.shown) found.push(section.dataset.section ?? '');
  }
  return found;
}

/** Takes every mark off, for a query emptied or a form left. */
export function clearSettingsSearch(root: Element): void {
  for (const marked of root.querySelectorAll(`[${MARK}]`)) marked.removeAttribute(MARK);
}

function fieldsOf(unit: Element): Element[] {
  return unit.matches('.settings-field')
    ? [unit]
    : Array.from(unit.querySelectorAll('.settings-field'));
}

function readUnit(unit: Element): UnitText {
  if (unit.tagName !== 'FIELDSET' && unit.querySelector('fieldset') !== null) {
    return { kind: 'nest', units: Array.from(unit.children).map(readUnit) };
  }
  const fields = fieldsOf(unit);
  const kind = unit.tagName === 'FIELDSET' ? 'group' : fields.length > 0 ? 'row' : 'other';
  return { kind, text: wordsOf(unit), fields: fields.map(wordsOf) };
}

function writeUnit(unit: Element, verdict: UnitVerdict): void {
  if (verdict.units.length > 0) {
    mark(unit, verdict.shown ? null : 'miss');
    Array.from(unit.children).forEach((child, index) => writeUnit(child, verdict.units[index]!));
    return;
  }
  const fields = fieldsOf(unit);
  if (!unit.matches('.settings-field')) mark(unit, verdict.shown ? null : 'miss');
  fields.forEach((field, index) => {
    const seen = verdict.fields[index];
    mark(field, seen === 'hit' ? 'hit' : seen === 'hidden' ? 'miss' : null);
  });
}

function mark(element: Element, value: 'hit' | 'miss' | null): void {
  if (value === null) element.removeAttribute(MARK);
  else if (element.getAttribute(MARK) !== value) element.setAttribute(MARK, value);
}

/**
 * The words a person reads on a unit: labels, legends and the hint sentences,
 * which are in the document while closed. A select's options and a textarea's
 * contents are values and are left out.
 */
function wordsOf(unit: Element): string {
  const walker = unit.ownerDocument.createTreeWalker(unit, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest('select, textarea')
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT
  });
  const parts: string[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    parts.push(node.nodeValue ?? '');
  }
  return parts.join(' ');
}
