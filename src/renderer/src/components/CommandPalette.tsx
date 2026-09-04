import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import Icon, { type IconName } from './Icon';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import { chord } from '../lib/platform';
import { useListNavigation } from '../hooks/useListNavigation';
import { tuning } from '../lib/tuning';

/**
 * Which cluster a command belongs to, in the order the clusters are shown.
 *
 * A flat list of thirty-odd commands reads as one wall of text, and the
 * settings screen was buried in exactly that wall until it got a name people
 * search for — grouping is the other half of being found: once somebody has
 * typed enough to narrow the list, the group a survivor came from is the
 * fastest way to tell "this is the one" from "keep reading".
 */
export type CommandGroup = 'character' | 'navigate' | 'view' | 'layout';

const GROUPS: CommandGroup[] = ['character', 'navigate', 'view', 'layout'];

const GROUP_LABEL: Record<CommandGroup, string> = {
  character: t('palette.groups.character'),
  navigate: t('palette.groups.navigate'),
  view: t('palette.groups.view'),
  layout: t('palette.groups.layout')
};

export interface Command {
  id: string;
  label: string;
  /**
   * The glyph in front of the label.
   *
   * Required, like a menu entry's. Thirty labels in a column are read word by
   * word, which is the slowest way to find the one you already know the shape
   * of — and half of them here begin with the same word (`Connect:`, `Show:`,
   * `Split:`, `Settings:`), so the first thing the eye meets is exactly the
   * part that does not distinguish them. Optional icons would be worse than
   * none: the labels would stop starting in one column and the edge the eye
   * runs down is what the glyphs are for.
   */
  icon: IconName;
  /**
   * The cluster this belongs to. Optional: a command with none sits ungrouped,
   * which is where a brand-new command should start until it is clear which
   * cluster it actually belongs in — guessing wrong here costs nothing but a
   * misplaced border, but it is still worth getting right rather than reaching
   * for the nearest one.
   */
  group?: CommandGroup;
  /**
   * Other words somebody might type looking for this.
   *
   * The palette matched on the label alone, and a label is what the *client*
   * calls a thing rather than what a person searching calls it. "Characters and
   * servers…" is a perfectly good name and is invisible to anybody typing
   * `settings`, `config`, `options`, `preferences`, `add`, `new` or `password`
   * — which is every word somebody actually reaches for.
   *
   * Never shown. This is for finding, not for reading.
   */
  keywords?: string[];
  /** Shown right-aligned: the equivalent shortcut, or the current value. */
  hint?: string;
  /**
   * Found by searching rather than part of the client's own vocabulary.
   *
   * A room out of the realm's 55,806, and later anything else a query can
   * reach. Two things follow, and both are why this is a flag rather than a
   * fifth `CommandGroup`: it is **not pinnable** — a shelf row that only exists
   * while somebody is typing the thing it names is a row nobody can reach from
   * the shelf — and it is never drawn while browsing, because a heading nobody
   * can expand into 55,806 rows is not a heading.
   */
  transient?: boolean;
  /**
   * True if running this deliberately parks focus somewhere other than the
   * terminal — the connection fields, say. The default is false, because the
   * terminal is where focus lives (see App.tsx). Without the opt-out, the
   * automatic return would immediately undo the command's own focus move.
   */
  movesFocus?: boolean;
  run(): void;
}

export interface CommandPaletteProps {
  open: boolean;
  commands: Command[];
  /**
   * The ids on the shelf, resolved from `internal.yaml` and whatever has been
   * pinned or unpinned by hand since (`usePinnedCommands`).
   */
  pinned: ReadonlySet<string>;
  /** Pin an unpinned command, or unpin a pinned one. */
  onTogglePin(id: string): void;
  /**
   * What else the query reaches, past the client's own vocabulary.
   *
   * The palette used to search one flat list of commands, which meant it could
   * only ever answer *"which of the things this client does did you mean"* —
   * and the thing somebody types a room name into a search box wanting is to
   * go there. This is asked as the query changes, debounced, and its rows are
   * drawn under their own heading below everything the client itself offers.
   *
   * Returning `Command`s rather than rooms is deliberate: the palette already
   * knows how to draw, navigate and run one, so a second kind of row would be
   * a second set of keys to keep in step with the first — the failure
   * `useListNavigation` exists because of. Every row it returns is `transient`.
   */
  find?(query: string): Promise<Command[]>;
  /**
   * @param movesFocus Whether the action that closed the palette is taking
   *   focus somewhere itself. When false — every dismissal, and most commands —
   *   the parent returns focus to the terminal.
   */
  onClose(movesFocus?: boolean): void;
}

/** A run of rows under one heading. `section` null is the ungrouped tail. */
interface Block {
  key: string;
  label: string | null;
  /** Set when the heading is a collapse toggle rather than a plain label. */
  toggles: CommandGroup | null;
  /** Whether the rows in it are boxed — the ungrouped tail is not. */
  boxed: boolean;
  items: Command[];
}

const PIN_CHORD = chord('P');

/**
 * The keyboard surface for everything that is not a game command.
 *
 * Chrome must never compete with the input line for keystrokes, so all
 * non-game actions live behind one explicitly invoked overlay. This is the one
 * dialog in the app that takes typing focus, and per the focus policy it hands
 * focus straight back to the terminal on the way out.
 *
 * It shows two things at once, because a palette is asked two different
 * questions. Opening it is *"give me the handful of commands I actually use"*
 * — the pinned section at the top, and under it every group collapsed to its
 * heading. Typing is *"find me the one I know exists"* — which searches
 * everything there is, because a command nobody can find does not exist. A
 * pinned command is drawn in the pinned section instead of in its own group,
 * in both modes: pinning moves a command to the top rather than copying it
 * there, so no row is ever in the list twice.
 */
export default function CommandPalette({
  open,
  commands,
  pinned,
  onTogglePin,
  onClose,
  find
}: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<CommandGroup>>(new Set());
  const [searched, setSearched] = useState<Command[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSearched([]);
    // Collapsed again each time: the palette opens to be glanced at, and what
    // is worth keeping between visits is the shelf, not the last expansion.
    setExpanded(new Set());
    // Focus after paint so the opening transition does not eat the caret.
    const id = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  const browsing = query.trim().length === 0;

  /*
   * What the query reaches past the command list, asked as it changes.
   *
   * Debounced and floored at the same figures the route panel's own field
   * uses, out of `internal.yaml`, because both are searching the same index of
   * 55,806 rooms and two surfaces answering the same typing at different
   * speeds is two behaviours to explain.
   *
   * A search that died leaves nothing standing: the previous query's rows must
   * not sit under the new query as though they were its answer — the same rule
   * the route panel keeps, and here it matters more, because Enter on a stale
   * row walks a character somewhere.
   */
  useEffect(() => {
    if (find === undefined) return;
    const needle = query.trim();
    if (needle.length < tuning().roomSearchMinChars) {
      setSearched([]);
      return;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      void find(needle)
        .then((rows) => {
          if (live) setSearched(rows);
        })
        .catch(() => {
          if (live) setSearched([]);
        });
    }, tuning().roomSearchDebounceMs);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [find, query]);

  const blocks = useMemo<Block[]>(() => {
    const needle = query.trim().toLowerCase();
    const matched = needle
      ? commands.filter(
          (command) =>
            command.label.toLowerCase().includes(needle) ||
            command.keywords?.some((word) => word.includes(needle))
        )
      : commands;

    // A found row is never on the shelf and never in a group: it exists for as
    // long as the query that found it, and `transient` is what says so.
    const onShelf = matched.filter((command) => pinned.has(command.id));
    const inGroup = (group: CommandGroup): Command[] =>
      matched.filter((command) => command.group === group && !pinned.has(command.id));

    const out: Block[] = [];
    if (onShelf.length > 0)
      out.push({
        key: 'pinned',
        label: t('palette.groups.pinned'),
        toggles: null,
        boxed: true,
        items: onShelf
      });

    for (const group of GROUPS) {
      const members = inGroup(group);
      if (browsing) {
        // Every heading is drawn whether or not it is open, so the whole shape
        // of what the client can do is visible from the first keystroke.
        out.push({
          key: group,
          label: GROUP_LABEL[group],
          toggles: group,
          boxed: true,
          items: expanded.has(group) ? members : []
        });
        continue;
      }
      if (members.length > 0)
        out.push({
          key: group,
          label: GROUP_LABEL[group],
          toggles: null,
          boxed: true,
          items: members
        });
    }

    if (!browsing) {
      const loose = matched.filter(
        (command) => command.group === undefined && !pinned.has(command.id)
      );
      if (loose.length > 0)
        out.push({ key: 'ungrouped', label: null, toggles: null, boxed: false, items: loose });

      /*
       * What the query reached past the client's vocabulary, last.
       *
       * Last because the commands *are* the palette: somebody typing `route`
       * means the Route command, and a screenful of rooms above it would bury
       * the thing they were reaching for. In practice a room query matches no
       * command at all, so these are usually the only rows there are — which
       * is what makes Enter on them the obvious next thing.
       */
      if (searched.length > 0)
        out.push({
          key: 'found',
          label: t('palette.groups.found'),
          toggles: null,
          boxed: true,
          items: searched
        });
    }

    return out;
  }, [browsing, commands, expanded, pinned, query, searched]);

  /** The rows in the order Enter and the arrows walk them. */
  const matches = useMemo(() => blocks.flatMap((block) => block.items), [blocks]);
  const order = useMemo(
    () => new Map(matches.map((command, index) => [command.id, index])),
    [matches]
  );

  const toggle = (group: CommandGroup): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };

  const choose = (command: Command): void => {
    onClose(command.movesFocus ?? false);
    command.run();
  };

  // Shared with every other filtered list, so they cannot drift apart again.
  const list = useListNavigation({ items: matches, onChoose: choose, onCancel: () => onClose() });

  /**
   * The caret stays in the field, so pinning needs a chord of its own: the
   * mouse has the pin on every row and the keyboard has this. Claimed before
   * the list sees the event, and the default prevented, because a browser is
   * free to have its own idea about `Ctrl P`.
   */
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') {
      event.preventDefault();
      // Nothing to pin on a found row — see `Command.transient`. Swallowed
      // rather than passed on, so the chord means one thing everywhere.
      if (list.active && list.active.transient !== true) onTogglePin(list.active.id);
      return;
    }
    list.onKeyDown(event);
  };

  if (!open) return null;

  return (
    <div className="palette-scrim" onMouseDown={() => onClose()} role="presentation">
      <div
        aria-label={t('palette.dialogLabel')}
        aria-modal="true"
        className="surface palette"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <input
          aria-label={t('palette.filterLabel')}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t('palette.filterPlaceholder')}
          ref={inputRef}
          value={query}
        />
        {matches.length === 0 && !browsing ? (
          <div className="empty">{t('palette.noMatches')}</div>
        ) : (
          <ul ref={list.listRef} role="listbox">
            {blocks.map((block) => (
              <Fragment key={block.key}>
                {block.label !== null && (
                  <li aria-hidden="true" className="palette-group-label" role="presentation">
                    {block.toggles ? (
                      <button
                        className="palette-group-toggle"
                        onClick={() => toggle(block.toggles as CommandGroup)}
                        onMouseDown={keepFocus}
                        tabIndex={-1}
                        type="button"
                      >
                        <Icon name={expanded.has(block.toggles) ? 'chevronDown' : 'chevronRight'} />
                        {block.label}
                        {!expanded.has(block.toggles) && (
                          <span className="hint">{countIn(commands, block.toggles, pinned)}</span>
                        )}
                      </button>
                    ) : (
                      block.label
                    )}
                  </li>
                )}
                {block.items.map((command, within) => {
                  const index = order.get(command.id) ?? -1;
                  const held = pinned.has(command.id);
                  /*
                   * A block's border is drawn from its edge items rather than
                   * from a wrapper element: `<ul>` accepts only `<li>`
                   * children, and boxing a run of them in a `<div>` is invalid
                   * nesting a browser is free to "fix" by hoisting it back
                   * out, which would take the keyboard-navigation and hover
                   * wiring the items sit on with it.
                   */
                  return (
                    <li
                      aria-selected={list.isActive(index)}
                      data-active={list.isActive(index) ? 'true' : 'false'}
                      data-group-end={
                        block.boxed && within === block.items.length - 1 ? 'true' : undefined
                      }
                      data-grouped={block.boxed ? 'true' : undefined}
                      key={command.id}
                      onClick={() => choose(command)}
                      onMouseEnter={() => list.point(index)}
                      role="option"
                    >
                      <Icon name={command.icon} />
                      <span>{command.label}</span>
                      {command.hint && <span className="hint">{command.hint}</span>}
                      {/*
                        No pin on a found row. It exists for as long as the
                        query that found it, so a shelf entry naming one would
                        be a row nobody can reach from the shelf — and the
                        column stays empty rather than carrying a control that
                        would do nothing, which is the rule the card action
                        column keeps.
                      */}
                      {command.transient !== true && (
                        <button
                          aria-hidden="true"
                          className="palette-pin"
                          data-pinned={held ? 'true' : 'false'}
                          onClick={(event) => {
                            // The row underneath runs the command.
                            event.stopPropagation();
                            onTogglePin(command.id);
                          }}
                          onMouseDown={keepFocus}
                          tabIndex={-1}
                          title={
                            held
                              ? t('palette.pin.unpinTitle', { chord: PIN_CHORD })
                              : t('palette.pin.pinTitle', { chord: PIN_CHORD })
                          }
                          type="button"
                        >
                          {/*
                           * Struck through where pressing it would release: this
                           * button carries no label, so the glyph is the only
                           * thing that can say which way it goes, and the accent
                           * fill alone would be stating a condition by colour.
                           */}
                          <Icon name={held ? 'unpin' : 'pin'} />
                        </button>
                      )}
                    </li>
                  );
                })}
              </Fragment>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** How many commands a collapsed group is holding back. */
function countIn(commands: Command[], group: CommandGroup, pinned: ReadonlySet<string>): number {
  return commands.filter((command) => command.group === group && !pinned.has(command.id)).length;
}
