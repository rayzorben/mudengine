import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal, type ILink, type IMarker } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';

import PopupMenu from './PopupMenu';
import { clipboardIntent, readClipboard, writeClipboard } from '../lib/clipboard';
import { t } from '../lib/i18n';
import { measurePitch } from '../lib/fonts';
import type { TerminalConfig } from '@shared/config';
import type { TerminalPalette } from '@shared/themes';
import type { StreamChunk, TerminalAction, TerminalMark, TerminalSize } from '@shared/types';
import { consoleWriter, noticeSequence, type ConsoleWriter } from '../lib/console';
import type { NameIndex, SpanHit } from '../lib/names';
import type { Box } from '../lib/menu';
import { anchorRect, type PopoverAnchor } from '../lib/popover';
import { MARK_GLYPH } from './marks';
import { splitMarks } from '../lib/chunks';

/** The handle the parent uses to drive the terminal once it has mounted. */
export interface TerminalHandle {
  write(chunk: StreamChunk): void;
  /**
   * Empty the screen and the scrollback, for a slate about to show a different
   * character. Concatenating two characters' output into one backscroll is
   * worse than losing it: the reader cannot tell where one ends.
   */
  reset(): void;
  /** Print an engine message inline, in the game's own visual language. */
  notice(message: string): void;
  jumpToLatest(): void;
  focus(): void;
  /** Find in the backscroll. Empty query clears the highlight. */
  search(query: string, direction: 'next' | 'previous'): void;
}

export interface TerminalViewProps {
  /** Called with each keystroke or pasted run the user produces. */
  onInput(data: string): void;
  /** Called whenever the measured grid changes, for Telnet NAWS. */
  onResize(size: TerminalSize): void;
  /** Registers the handle the parent uses to push output in. */
  onReady(handle: TerminalHandle): void;
  /** Reports match counts as the query changes. */
  onSearchResult(result: { index: number; count: number } | undefined): void;
  /**
   * Every name the realm knows, for the console to recognise.
   *
   * Underlined on hover and clickable, through xterm's link provider — which
   * is asked about the row under the pointer and nothing else, so a realm of
   * three thousand names costs nothing until somebody points at one.
   */
  /** The console's name index — the realm's names and the people this character knows — or null before the realm's names arrive. */
  index?: NameIndex | null;
  /** A recognised name was clicked, and here is the cell box it occupies. */
  onInspect?(name: string, at: PopoverAnchor): void;
  /** A person's name clicked in the console: the Player flyout, beside the cells. */
  onSelectPlayer?(name: string, at: PopoverAnchor): void;
  /**
   * A gang's name clicked in the console: the Gang flyout, beside the cells.
   *
   * Its own handler rather than a kind the reference panel answers, for the
   * reason a person's is: what the client knows about a gang is who is in it,
   * and every one of those is itself an entity to click through to — which is
   * a panel, not a realm lookup.
   */
  onSelectGang?(name: string, at: PopoverAnchor): void;
  /**
   * A room's name clicked in the console: the route panel, on that room.
   *
   * A separate handler rather than a kind the reference panel answers,
   * because the question somebody asks about a room they are not standing in
   * is *how do I get there* — the rule the map and the Route face already
   * follow. The name rather than a `map/room` pair: a room name is routinely
   * shared by several rooms, and choosing one of them here would be the guess
   * this project refuses.
   */
  onChooseRoom?(name: string): void;
  /** Live presentation options from the YAML file. */
  settings: TerminalConfig;
  /** The resolved CSS font stack for `settings.font.family`. */
  fontStack: string;
  /** The active theme's 16-colour palette and ground. */
  palette: TerminalPalette;
  /**
   * Whether this terminal's measurements may be reported.
   *
   * False for a terminal that is mounted but not being shown. A hidden terminal
   * keeps its box so it can still be measured, but the measurement is not
   * *authoritative*: hiding one perturbs its own cell metrics — the renderer
   * changes underneath it — and publishing that sends a geometry the player
   * never saw. The server then re-wraps the scrollback of a character standing
   * still, which is rule 8 of docs/profiles.md §8.
   *
   * The last size reported while shown therefore stands until it is shown
   * again, at which point it reports whatever it really is now.
   */
  reportSize?: boolean;
}

/**
 * The slate.
 *
 * Per docs/ui-design.md §1 nothing in here is translucent, rounded, animated or
 * tinted: the frame around it participates in the bento grid, but the ground
 * itself is opaque black and the character cell is never disturbed.
 */
export default function TerminalView({
  onInput,
  onResize,
  onReady,
  onSearchResult,
  index,
  onInspect,
  onSelectPlayer,
  onSelectGang,
  onChooseRoom,
  reportSize = true,
  settings,
  fontStack,
  palette
}: TerminalViewProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [pinned, setPinned] = useState(true);

  /**
   * Where the right-click menu is, and what was selected when it opened.
   *
   * The selection is captured with the click rather than read again when Copy
   * runs: what the entry copies is then exactly what was highlighted when the
   * menu was asked for, and the greyed-out state and the action cannot
   * disagree about it.
   */
  const [menu, setMenu] = useState<{ x: number; y: number; selection: string } | null>(null);

  /**
   * True while a selection is holding the viewport still.
   *
   * A read through a ref rather than through state because the writer below
   * consults it inside xterm's own callback, where a stale render's copy would
   * scroll the reader's selection off the screen — which is the exact thing
   * this exists to prevent.
   */
  const holdRef = useRef(false);

  /**
   * The one thing that writes to this console, once the terminal exists.
   *
   * A ref because the console has more than one author and they are in
   * different effects: the stream's chunks and the client's notices are
   * handed out through the handle below, and the font warning is raised by
   * the effect that measures the face. A second author calling `term.write`
   * directly would be a second queue, which is precisely what having one is
   * for.
   */
  const writerRef = useRef<ConsoleWriter | null>(null);

  /**
   * Options at mount time. The terminal is constructed exactly once — throwing
   * away the xterm instance on a font change would throw away the backscroll
   * with it — so the initial values are read through a ref and every later
   * change is applied by the effect below instead.
   */
  const initial = useRef({ settings, fontStack, palette });

  /**
   * The parent re-renders on every state change, but the xterm instance must be
   * created exactly once. Callbacks are read through a ref so the effect below
   * never needs them in its dependency list.
   */
  const handlers = useRef({
    onInput,
    onResize,
    onReady,
    onSearchResult,
    onInspect,
    onSelectPlayer,
    onSelectGang,
    onChooseRoom
  });
  handlers.current = {
    onInput,
    onResize,
    onReady,
    onSearchResult,
    onInspect,
    onSelectPlayer,
    onSelectGang,
    onChooseRoom
  };

  /*
   * The name index, rebuilt only when the realm's names change — once per
   * session in practice — and read through a ref by the link provider, which
   * is registered once with the terminal.
   */
  /*
   * The name index, owned by `App` — one object per character, the realm's
   * names built once and the people set onto it in place — and read through
   * a ref by the link provider, which is registered once with the terminal.
   * Shared with the cards that quote the server's sentences, so the console
   * and a card cannot disagree about what is a name.
   */
  const namesRef = useRef<NameIndex | null>(null);
  useEffect(() => {
    namesRef.current = index ?? null;
  }, [index]);

  /** Read through a ref so the terminal's own listeners see the current value. */
  const reportRef = useRef(reportSize);

  /**
   * Read at search time rather than captured at mount, so the overview-ruler
   * marks a search paints follow a theme swap instead of keeping the colours
   * of whatever theme was active when the terminal was built.
   */
  const paletteRef = useRef(palette);
  paletteRef.current = palette;

  /*
   * Becoming visible republishes the geometry.
   *
   * While hidden this terminal has been holding whatever it last reported for
   * real, so anything that changed the window in the meantime has to be told
   * now — otherwise the character keeps formatting to a window size that no
   * longer exists.
   */
  useEffect(() => {
    const wasReporting = reportRef.current;
    reportRef.current = reportSize;
    const term = termRef.current;
    if (!reportSize || wasReporting || !term) return;
    fitRef.current?.fit();
    handlers.current.onResize({ cols: term.cols, rows: term.rows });
  }, [reportSize]);

  /**
   * Jumping back to the live edge is a terminal action, so it ends with focus
   * in the terminal — clicking the button would otherwise leave focus on the
   * button and swallow the next thing the user types.
   *
   * It also drops any selection, because a selection is what stops the view
   * following the game (see `holdRef`), and a button that says "jump to
   * latest" must actually resume following rather than snap back once and
   * freeze again on the next line the server sends.
   */
  const jumpToLatest = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    holdRef.current = false;
    term.clearSelection();
    term.scrollToBottom();
    term.focus();
    setPinned(true);
  }, []);

  /**
   * Copy what is selected — or what was, when a menu was opened over it — and
   * then let go of it.
   *
   * **Copying is the end of the gesture**, so it releases the hold and returns
   * to the live edge. It did not, at first: the selection stayed, which meant
   * the console stayed frozen where the reader had stopped it, and a player who
   * had just taken a copy of something went on playing into a view that had
   * quietly stopped following the game. Keeping it would only be worth
   * anything to somebody about to copy the *same run twice*, which is not what
   * anybody does; and the run is on the clipboard by then anyway.
   *
   * Nothing is lost by releasing: the backscroll is still there, and scrolling
   * up again is one wheel turn.
   */
  const copySelection = useCallback(
    (text?: string) => {
      void writeClipboard(text ?? termRef.current?.getSelection() ?? '');
      jumpToLatest();
    },
    [jumpToLatest]
  );

  /**
   * Paste through the terminal's own paste path, not straight at the socket.
   *
   * `Terminal.paste` normalises the line endings and brackets the run if the
   * server asked for bracketed paste, then raises it as ordinary input — so it
   * arrives at `onInput` down the identical path a keystroke takes, and
   * everything hung off that path (the tracker, the capture, the redaction of
   * an answer to a password prompt) sees it. A second route to the socket
   * would be a second copy of all of that, and copies drift.
   *
   * It scrolls to the live edge afterwards, which xterm does for itself on a
   * keystroke and cannot do here: intercepting the chord means its own
   * scroll-on-input never runs. Typing into a view you cannot see is how a
   * command goes somewhere unintended.
   */
  const pasteClipboard = useCallback(() => {
    void readClipboard().then((text) => {
      const term = termRef.current;
      if (!term || text.length === 0) return;
      term.paste(text);
      term.scrollToBottom();
    });
  }, []);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const term = new Terminal({
      allowProposedApi: true,
      convertEol: false,
      cursorBlink: initial.current.settings.cursorBlink,
      cursorStyle: initial.current.settings.cursorStyle,
      // The virtualised backscroll requirement: xterm keeps only the viewport in
      // the DOM and the rest in a circular buffer, so 100k lines costs memory
      // proportional to content, not to rendered nodes.
      scrollback: initial.current.settings.scrollback,
      fontFamily: initial.current.fontStack,
      fontSize: initial.current.settings.font.size,
      lineHeight: 1,
      letterSpacing: 0,
      theme: initial.current.palette,
      // Server output is never rewrapped by us; the game formats to a fixed
      // width and rewrapping would corrupt ASCII maps and box art.
      windowsMode: false
    });

    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    term.loadAddon(new Unicode11Addon());
    /*
     * A web address the realm printed becomes clickable.
     *
     * The one decoration the console is allowed. It adds no layout — xterm
     * draws the underline in the cell the character already occupies — so the
     * maps, frames and stat columns the game lays out in character cells are
     * untouched, which is the rule the terminal is otherwise exempt from
     * everything for.
     *
     * `window.open` rather than an IPC of its own: main's window-open handler
     * already refuses to open anything in the app frame, and it is where the
     * *scheme* is checked. What is being clicked is text somebody else typed
     * into a MUD, and handing an arbitrary string to the operating system is a
     * different act from opening a web page.
     *
     * The handler is explicit because the addon's default one does not work
     * here at all: it calls `window.open()` with **no URL** and then assigns
     * `location.href` to the window it gets back — and main's handler, seeing
     * `about:blank`, denies the open and hands back nothing, so the click
     * died in silence. Passing the URI through `window.open` directly is what
     * lets the main-side scheme check see the real address and hand it to the
     * operating system's browser.
     */
    term.loadAddon(new WebLinksAddon((_event, uri) => window.open(uri)));
    term.unicode.activeVersion = '11';

    /*
     * A name the realm knows becomes clickable, the same way a web address
     * does and with the same guarantee: xterm draws the underline in the cell
     * the character already occupies, so nothing the server laid out moves.
     * Asked about the row under the pointer only, and answered from an index
     * built once, so a hover costs a few lookups and no round trip. The
     * click opens the realm's answer beside the word: the cell box is handed
     * up, because a cell has no element for a panel to anchor to.
     *
     * The row is read with its neighbours, because a name can be folded
     * across two of them — by the server, which breaks some listings at a
     * word (the carried listing arrived as `silk` at the end of one row and
     * `trousers` at the start of the next), or by the pane, which wraps a
     * long line at the cell. `isWrapped` tells the two apart, and a row
     * followed by a pane wrap keeps its trailing spaces, because the space
     * at that fold is a real cell.
     *
     * A pane wrap is one link across two rows, the shape the web-links addon
     * uses for a wrapped address: the cells are contiguous, so the underline
     * is too. A server fold is not — xterm draws a two-row range over every
     * cell between its ends, and after a hard break that is the empty tail of
     * the first row, so `golden` was underlined out to the right edge before
     * `amulet` was. So a folded name is two links, each to its own word's
     * end, and hovering either lays an underline over the other through the
     * decoration layer, which is where the client already draws what the
     * grid cannot. Each half anchors the answer to itself.
     */
    const links = term.registerLinkProvider({
      provideLinks: (row, callback) => {
        const index = namesRef.current;
        const buffer = term.buffer.active;
        const line = buffer.getLine(row - 1);
        if (!index || !line) {
          callback(undefined);
          return;
        }
        const above = buffer.getLine(row - 2);
        const below = buffer.getLine(row);
        const text = line.translateToString(!below?.isWrapped);
        const rows = [
          { text: above?.translateToString(!line.isWrapped) ?? '', continues: false },
          { text, continues: line.isWrapped },
          { text: below?.translateToString(true) ?? '', continues: below?.isWrapped ?? false }
        ];
        // Row 1 of the three is the one asked about; a hit wholly on a
        // neighbour is that neighbour's to report when it is pointed at.
        const hits = index
          .findAcross(rows)
          .filter((hit) => hit.start.line <= 1 && hit.end.line >= 1);
        if (hits.length === 0) {
          callback(undefined);
          return;
        }

        /** A run of cells on one buffer row (zero-based; `to` exclusive). */
        interface Segment {
          bufferRow: number;
          from: number;
          to: number;
        }
        const pointer = (event: MouseEvent): Box => ({
          left: event.clientX,
          right: event.clientX,
          top: event.clientY,
          bottom: event.clientY
        });
        /*
         * What a click on a name opens: a person, the Player flyout — the
         * same question a click on a listing asks; anything the realm knows,
         * its answer. One gesture on every name the console recognises, which
         * is what makes the console a surface the rest of the client already
         * has, rather than a second vocabulary.
         */
        const open = (hit: SpanHit, at: PopoverAnchor): void => {
          if (hit.kind === 'player') {
            /*
             * Paired with the mount, not the screen. The realm's answer about
             * a word closes when the console scrolls, because the word moved;
             * a person's flyout carries the Access face, which writes to the
             * options file, and a gate that closes on the next line the game
             * prints is unusable in a busy room — the reason a popover was
             * once ruled out for it. The mount is the viewport's parent and
             * never scrolls, so the panel stays where the name was clicked,
             * like a right-click menu, until Escape or a click elsewhere.
             */
            handlers.current.onSelectPlayer?.(hit.text, { box: anchorRect(at), within: mount });
          } else if (hit.kind === 'gang') {
            /*
             * A gang, paired with the mount for the same reason a person is:
             * the panel is read and clicked through — a member's name opens
             * the flyout on *them* — and one that closed on the next line the
             * game printed would be unusable in a busy room.
             */
            handlers.current.onSelectGang?.(hit.text, { box: anchorRect(at), within: mount });
          } else if (hit.kind === 'room') {
            /*
             * A room is the one kind whose answer is not a readout. The realm
             * knows where it is, and what a person wants from a place they are
             * not standing in is the way there — so this opens the route panel
             * the map and the Route face already open, rather than a card
             * restating a name they just read.
             */
            handlers.current.onChooseRoom?.(hit.text);
          } else {
            handlers.current.onInspect?.(hit.text, at);
          }
        };
        const link = (hit: SpanHit, own: Segment, other?: Segment): ILink => {
          let shadow: { dispose(): void } | undefined;
          const clear = (): void => {
            shadow?.dispose();
            shadow = undefined;
          };
          return {
            range: {
              start: { x: own.from + 1, y: own.bufferRow + 1 },
              end: { x: own.to, y: own.bufferRow + 1 }
            },
            text: hit.text,
            activate: (event) => {
              open(hit, cellAnchor(term, mount, own.from, own.to, own.bufferRow, pointer(event)));
            },
            hover: () => {
              clear();
              if (other) shadow = underline(term, other);
            },
            leave: clear,
            dispose: clear
          };
        };

        callback(
          hits.flatMap((hit) => {
            const startRow = row + hit.start.line - 2;
            const endRow = row + hit.end.line - 2;
            if (hit.start.line !== hit.end.line && !rows[hit.end.line]!.continues) {
              const head: Segment = {
                bufferRow: startRow,
                from: hit.start.col,
                to: rows[hit.start.line]!.text.length
              };
              const tail: Segment = { bufferRow: endRow, from: 0, to: hit.end.col };
              return [link(hit, head, tail), link(hit, tail, head)];
            }
            return [
              {
                range: {
                  start: { x: hit.start.col + 1, y: startRow + 1 },
                  end: { x: hit.end.col, y: endRow + 1 }
                },
                text: hit.text,
                activate: (event) => {
                  const from = hit.start.line === 1 ? hit.start.col : 0;
                  const to = hit.end.line === 1 ? hit.end.col : text.length;
                  open(hit, cellAnchor(term, mount, from, to, row - 1, pointer(event)));
                }
              }
            ];
          })
        );
      }
    });

    const search = new SearchAddon();
    term.loadAddon(search);
    search.onDidChangeResults((result) =>
      handlers.current.onSearchResult(
        result && result.resultCount > 0
          ? { index: result.resultIndex, count: result.resultCount }
          : undefined
      )
    );

    term.open(mount);

    // WebGL keeps frame times flat during combat bursts. It is unavailable in
    // some VMs and on stale drivers, and it can be lost at runtime, so both
    // failure paths fall back to the DOM renderer rather than breaking.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // DOM renderer remains active; nothing further to do.
    }

    termRef.current = term;

    const publishSize = (): void => {
      if (!reportRef.current) return;
      handlers.current.onResize({ cols: term.cols, rows: term.rows });
    };

    fit.fit();
    publishSize();

    /**
     * A selection holds the view still, exactly as backscrolling does.
     *
     * Highlighting something the server is still writing under is a race the
     * reader loses: the viewport follows the live edge, the highlighted run
     * scrolls off, and a drag that was half finished cannot be finished at
     * all. So a selection *is* a backscroll — the same pin, released the same
     * ways — rather than a second mechanism that has to be kept in step with
     * it. Nothing here re-implements scrolling: it stops the writer below
     * scrolling, which is what the pin already meant.
     */
    const selectionListener = term.onSelectionChange(() => {
      holdRef.current = term.hasSelection();
    });

    /*
     * The hold starts at the press, not when the selection is announced.
     *
     * xterm raises `onSelectionChange` on mouse-**up**: the model is updated
     * as the pointer moves, but nothing is fired until the gesture ends. A
     * drag with output arriving under it would therefore have scrolled the
     * very run being highlighted off the screen before anything knew a
     * selection was being made — which is the half of this that matters, since
     * a finished selection can always be made again and an interrupted one
     * cannot be finished at all.
     *
     * The press is watched here and the release on the document, because a
     * drag that started in the console does not have to end there.
     */
    let selecting = false;
    let followingAtPress = false;
    const startSelecting = (event: MouseEvent): void => {
      if (event.button !== 0) return;
      selecting = true;
      followingAtPress = term.buffer.active.viewportY >= term.buffer.active.baseY;
      holdRef.current = true;
    };
    const stopSelecting = (): void => {
      if (!selecting) return;
      selecting = false;
      const selected = term.hasSelection();
      holdRef.current = selected;
      /*
       * A press that selected nothing is a click — and a click in the console
       * must never be a way to quietly stop it following the game. Output
       * arriving during those few milliseconds was held like any other, which
       * leaves the viewport a line or two behind the live edge with nothing on
       * screen to say why. Only what the press itself moved is put back: a
       * click made while genuinely backscrolled leaves the reader where they
       * were, which is where they asked to be.
       */
      if (!selected && followingAtPress) term.scrollToBottom();
    };
    mount.addEventListener('mousedown', startSelecting);
    document.addEventListener('mouseup', stopSelecting);

    term.onData((data) => {
      /*
       * Typing is playing, and playing outranks a selection left lying
       * around. Without this, a command sent with an hour-old highlight still
       * on screen would go out into a view frozen above the answer — during a
       * fight, which is when it matters, that is a client that has quietly
       * stopped showing the game.
       */
      if (holdRef.current) {
        holdRef.current = false;
        term.clearSelection();
      }
      handlers.current.onInput(data);
    });
    term.onResize(publishSize);

    /*
     * Copy and paste, from the keyboard.
     *
     * xterm calls this before doing anything with a key and takes `false` as
     * "leave it alone" — but it does not prevent the *browser* default, so a
     * chord handled here has to say so itself or Chromium's own paste command
     * fires as well and the run arrives twice.
     */
    term.attachCustomKeyEventHandler((event) => {
      const intent = clipboardIntent(event, term.hasSelection());
      if (intent === null) return true;
      event.preventDefault();
      if (intent === 'copy') copySelection();
      else pasteClipboard();
      return false;
    });

    /**
     * Auto-scroll pinning. `scrollToBottom` on every chunk would fight the user
     * the moment they scroll up to read backscroll, so writes only scroll while
     * the viewport is already at the bottom, and the pin re-establishes itself
     * as soon as they return to the live edge.
     */
    const syncPin = (): void => {
      const buffer = term.buffer.active;
      setPinned(buffer.viewportY >= buffer.baseY);
    };

    const scrollListener = term.onScroll(syncPin);

    /**
     * The DOM listener is not redundant. `onScroll` covers the buffer scrolling
     * because output arrived, but xterm's viewport suppresses that event for
     * scrolls the *user* initiates — wheel, scrollbar drag, keyboard — to avoid
     * feeding its own DOM scroll handler back into itself. Listening only to
     * `onScroll` therefore means the pin never releases: writes keep yanking
     * the view back down, and the jump-to-latest affordance never appears at
     * all, because from React's point of view the viewport is always pinned.
     */
    const viewport = mount.querySelector('.xterm-viewport');
    viewport?.addEventListener('scroll', syncPin, { passive: true });

    /**
     * The one thing that writes to this console, for as long as it lives.
     *
     * The server's chunks, the client's notices, the font warning and the
     * reset between two characters all go through it in the order they were
     * asked for. Two of them have to *read* the screen first — where a marked
     * line lands, whether a notice already has a line of its own — and
     * `term.buffer` answers for what has been parsed rather than for what has
     * been queued. See `consoleWriter`: waiting for that answer is exactly the
     * window in which the next chunk off the socket used to overtake the line
     * still waiting to be written.
     */
    const writer = consoleWriter(term);
    writerRef.current = writer;

    handlers.current.onReady({
      write: (chunk) => {
        const buffer = term.buffer.active;
        const wasPinned = buffer.viewportY >= buffer.baseY;
        /*
         * The line the reader is on, captured before the write moves the
         * buffer underneath it. A viewport already at the live edge follows
         * the new output on its own, so holding it still means putting it
         * back — and putting it back where it *was* is what makes a selection
         * behave as a backscroll rather than as a second kind of stillness.
         *
         * Read as the chunk is handed over rather than at the moment it is
         * written, and that is deliberate: both figures are the reader's own
         * viewport against the buffer's edge, and anything still queued ahead
         * of this chunk has moved neither of them. Waiting to read them would
         * cost the flush the plain case exists to avoid.
         */
        const held = holdRef.current ? buffer.viewportY : null;
        const settle = (): void => {
          if (held !== null) {
            if (term.buffer.active.viewportY !== held) term.scrollToLine(held);
            return;
          }
          if (wasPinned) term.scrollToBottom();
        };
        /*
         * A marked line is written on its own, with a marker registered at
         * the row it lands on and a decoration hung off the marker — an
         * element laid over the cells, outside the grid, so the glyph beside
         * a bank's name moves nothing and no escape sequence that counts
         * columns ever sees it. The marker has to be taken when the cursor is
         * really on the row, so a marked segment is the writer's `settled`
         * and an unmarked one is a plain write that costs nothing.
         */
        const segments = splitMarks(chunk);
        if (segments.length === 0) {
          settle();
          return;
        }
        segments.forEach((segment, index) => {
          const last = index === segments.length - 1;
          const mark = segment.mark;
          if (!mark) {
            writer.write(segment.text, last ? settle : undefined);
            return;
          }
          writer.settled(() => {
            const marker = term.registerMarker(0);
            /*
             * A marked line is indented two cells so the glyph has a place
             * *before* the name rather than over its first letters. This is
             * the one place the console's text is not the server's byte for
             * byte, and it is confined to a plain line — a room's name — that
             * no server sequence ever re-addresses: the in-place repaint works
             * on the prompt row. The log and the capture carry the line as
             * sent.
             */
            term.write(`${MARK_INDENT}${segment.text}`, () => {
              if (marker) {
                decorate(term, marker, mark, segment.text, (command) =>
                  handlers.current.onInput?.(`${command}\r`)
                );
              }
              if (last) settle();
            });
          });
        });
      },
      /*
       * The slate between two characters, in the queue rather than around it:
       * a reset that jumped the line would clear the screen and then have the
       * previous character's last chunk painted onto it.
       */
      reset: () => writer.settled(() => term.reset()),
      notice: (message) => {
        /*
         * The bytes are `noticeSequence`'s — a decision with two edge cases,
         * which is where this codebase puts a pure function rather than an
         * inline branch. What is left here is the *timing*, which is the part
         * a canvas is needed to observe.
         *
         * `term.buffer` answers for what has been **parsed**, not for what has
         * been queued: xterm processes writes on a later task. Three notices
         * raised in one turn would all read the cursor as it was before any of
         * them, so all three would decide the same way and two would be wrong.
         * `settled` is the one moment the buffer answers for what is on
         * screen — everything asked for before this notice has been parsed,
         * and nothing asked for after it has been written yet.
         */
        writer.settled(() => {
          const atLineStart = term.buffer.active.cursorX === 0;
          term.write(noticeSequence(message, atLineStart));
        });
      },
      jumpToLatest,
      focus: () => term.focus(),
      search: (query, direction) => {
        if (query.length === 0) {
          search.clearDecorations();
          handlers.current.onSearchResult(undefined);
          return;
        }
        /*
         * The theme's own inks, not literal colours: brightYellow marks every
         * match and brightWhite — the strongest ink in dark and light palettes
         * alike — marks the active one, so the ruler stays legible on a light
         * theme's paper instead of painting white on white.
         */
        const options = {
          decorations: {
            matchOverviewRuler: paletteRef.current.brightYellow,
            activeMatchColorOverviewRuler: paletteRef.current.brightWhite
          }
        };
        if (direction === 'next') search.findNext(query, options);
        else search.findPrevious(query, options);
      }
    });

    const observer = new ResizeObserver(() => {
      // Guard against the zero-size measurement that fires while the window is
      // minimised, which would otherwise report a 1x1 grid over NAWS.
      if (mount.clientWidth > 0 && mount.clientHeight > 0) fit.fit();
    });
    observer.observe(mount);

    return () => {
      links.dispose();
      observer.disconnect();
      viewport?.removeEventListener('scroll', syncPin);
      scrollListener.dispose();
      selectionListener.dispose();
      mount.removeEventListener('mousedown', startSelecting);
      document.removeEventListener('mouseup', stopSelecting);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      // The writer holds the disposed terminal; the font measurement resolves
      // on its own schedule and must not write into it.
      writerRef.current = null;
    };
  }, []);

  /**
   * Applies option changes from a config reload without rebuilding the
   * terminal. Font and size change the cell metrics, so the grid has to be
   * re-measured afterwards — otherwise the server keeps being told the old
   * geometry over NAWS and formats to a width that no longer exists.
   */
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    const metricsChanged =
      term.options.fontFamily !== fontStack || term.options.fontSize !== settings.font.size;

    term.options.fontFamily = fontStack;
    term.options.fontSize = settings.font.size;
    term.options.scrollback = settings.scrollback;
    term.options.cursorBlink = settings.cursorBlink;
    term.options.cursorStyle = settings.cursorStyle;

    if (metricsChanged) fitRef.current?.fit();
  }, [fontStack, settings]);

  /**
   * Repaints the grid when the theme changes.
   *
   * Separate from the effect above because a palette swap costs a full
   * re-render of every cell and must not be triggered by an unrelated font or
   * scrollback edit. Colours do not touch cell metrics, so no refit follows.
   */
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = palette;
  }, [palette]);

  /**
   * Verifies that what the browser actually resolved is fixed-pitch.
   *
   * The config layer guarantees the *stack* ends in `monospace`, but a user's
   * first choice can still resolve to a proportional face that happens to be
   * installed, and a font can be monospace for Latin while falling back to a
   * differently-sized face for CP437 block glyphs. Either shears every map and
   * frame the game draws, so it is reported in the stream rather than left for
   * the user to discover by eye.
   */
  useEffect(() => {
    // `document.fonts.ready` matters on the first paint: measuring before the
    // bundled faces have loaded reports the fallback's metrics, not theirs.
    let live = true;
    void document.fonts.ready.then(() => {
      if (!live) return;
      const writer = writerRef.current;
      if (!writer) return;
      const pitch = measurePitch(fontStack, settings.font.size);
      if (pitch.monospace) return;
      const warning = t('terminal.fontNotFixedPitch', {
        fontName: fontStack.split(',')[0]?.trim() ?? fontStack,
        widest: pitch.widest,
        narrowest: pitch.narrowest
      });
      // Through the writer like everything else: the faces resolve while the
      // opening banner is arriving, and a warning written past the queue
      // would land in the middle of a line the server was halfway through.
      writer.write(`\r\n\x1b[1;30;43m ${warning} \x1b[0m\r\n`);
    });

    return () => {
      live = false;
    };
  }, [fontStack, settings.font.size]);

  /** Leaving the menu is a terminal action, so the keyboard goes back there. */
  const dismissMenu = useCallback(() => {
    setMenu(null);
    termRef.current?.focus();
  }, []);

  return (
    <div
      className="terminal-cell"
      /*
       * The right-click menu.
       *
       * On the cell rather than on the mount so a click in the padding around
       * the grid still opens it, and `preventDefault` because the browser's
       * own menu here offers nothing that applies to a terminal — and a
       * built-in menu appearing over the game is the one surface in this app
       * whose look nobody controls.
       */
      onContextMenu={(event) => {
        event.preventDefault();
        setMenu({
          x: event.clientX,
          y: event.clientY,
          selection: termRef.current?.getSelection() ?? ''
        });
      }}
    >
      <div className="terminal-mount" ref={mountRef} />
      {!pinned && (
        <button className="jump-latest" onClick={jumpToLatest} type="button">
          {t('terminal.jumpToLatest')}
        </button>
      )}
      {menu !== null && (
        <PopupMenu
          at={menu}
          items={[
            {
              label: t('terminal.contextMenu.copy'),
              icon: 'copy',
              disabled: menu.selection.length === 0,
              run: () => {
                dismissMenu();
                copySelection(menu.selection);
              }
            },
            {
              label: t('terminal.contextMenu.paste'),
              icon: 'paste',
              run: () => {
                dismissMenu();
                pasteClipboard();
              }
            }
          ]}
          onDismiss={dismissMenu}
        />
      )}
    </div>
  );
}

/**
 * The glyph before a line, hung off its marker.
 *
 * `registerDecoration` is xterm's own overlay layer: an element positioned
 * over a cell row, tracking it through scrollback and disposed with the line.
 * Placed over the two cells the indent left empty, with the shop's name as
 * its tooltip and its accessible label — a glyph alone says nothing, per §6.
 */
/** Cells a marked line is indented by, for the glyph to sit in. */
const MARK_INDENT = '  ';

/**
 * SGR colour sequences, for counting the cells a line actually paints.
 *
 * Only the `m` final byte: this measures a room's name, and the server has
 * never sent anything else inside one. A cursor-movement sequence would need
 * the terminal's own state to interpret, which is xterm's job, not this
 * measurement's.
 */
const ANSI = /\x1b\[[0-9;]*m/g;
function decorate(
  term: Terminal,
  marker: IMarker,
  mark: TerminalMark,
  text: string,
  send: (command: string) => void
): void {
  const decoration = term.registerDecoration({ marker, x: 0, width: MARK_INDENT.length });
  if (!decoration) return;
  decoration.onRender((element) => {
    if (element.dataset['mark'] === mark.icon) return;
    element.dataset['mark'] = mark.icon;
    // Added, never assigned: xterm's own class carries the positioning.
    element.classList.add('terminal-mark');
    element.title = mark.label;
    element.setAttribute('role', 'img');
    element.setAttribute('aria-label', mark.label);
    element.innerHTML = MARK_GLYPH[mark.icon];
  });
  if (mark.actions?.length) actionButtons(term, marker, mark.actions, text, send);
}

/**
 * The buttons after a marked line's text.
 *
 * The same decoration layer as the glyph, and outside the grid for the same
 * reason: a control *inside* the cells would move everything the server laid
 * out beside it, and every escape sequence that counts columns would see it.
 * They start one cell past the last character of the line, so nothing the
 * server printed is covered.
 *
 * **No pixel constant.** The width is stated in cells and xterm places it from
 * its own measured cell size, which is the rule the column measurement already
 * records — the terminal font is configurable and the pane is resizable, so a
 * width decided here would be wrong for somebody.
 *
 * A press sends the command down the path a keystroke takes — the Talk card's
 * rule — and hands the caret straight back, because this is a control that is
 * clicked and never typed into.
 */
function actionButtons(
  term: Terminal,
  marker: IMarker,
  actions: readonly TerminalAction[],
  text: string,
  send: (command: string) => void
): void {
  /*
   * One cell of air after the **visible** text.
   *
   * `segment.text` is what the server sent — colour sequences and the line
   * terminator included — and counting those put the buttons thirteen columns
   * right of where `Town Square` ends, because a two-word name arrives as
   * twenty-four bytes and paints eleven cells. A column is a cell, so only
   * what paints may be counted.
   */
  const printed = text.replace(ANSI, '').replace(/[\r\n]/g, '');
  const from = MARK_INDENT.length + printed.length + 1;
  const width = Math.max(1, term.cols - from);
  const decoration = term.registerDecoration({ marker, x: from, width });
  if (!decoration) return;
  decoration.onRender((element) => {
    if (element.dataset['actions'] === 'true') return;
    element.dataset['actions'] = 'true';
    element.classList.add('terminal-actions');
    for (const action of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'terminal-action';
      button.textContent = action.label;
      button.title = action.title;
      // A control that is clicked but never typed into refuses the mouse's
      // attempt to park the caret, and leaves keyboard focus alone.
      button.addEventListener('mousedown', (event) => event.preventDefault());
      /*
       * Each command down the same path a keystroke takes, in order. The
       * arbiter paces them exactly as it paces typing, so `i` and the deposit
       * that reads its answer arrive as two commands rather than one line.
       */
      button.addEventListener('click', () => {
        for (const command of action.commands) send(command);
      });
      element.append(button);
    }
  });
}

/**
 * An underline laid over a run of cells that xterm is not underlining itself:
 * the other half of a name the server folded, while the pointer is on this
 * half. The decoration layer, like a mark's glyph, so nothing in the grid
 * moves. The marker is stated from the cursor, which is how xterm addresses
 * a buffer line; both are released together, and the line scrolling out of
 * the buffer releases them anyway.
 */
function underline(
  term: Terminal,
  cells: { bufferRow: number; from: number; to: number }
): { dispose(): void } | undefined {
  const buffer = term.buffer.active;
  const marker = term.registerMarker(cells.bufferRow - (buffer.baseY + buffer.cursorY));
  const decoration = term.registerDecoration({
    marker,
    x: cells.from,
    width: Math.max(1, cells.to - cells.from)
  });
  if (!decoration) {
    marker.dispose();
    return undefined;
  }
  // Added, never assigned: xterm's own class carries the positioning.
  decoration.onRender((element) => element.classList.add('terminal-link-shadow'));
  return {
    dispose: () => {
      decoration.dispose();
      marker.dispose();
    }
  };
}

/**
 * The screen box of a run of cells, for a panel to open beside, paired with
 * the element it was measured in.
 *
 * From the terminal's own geometry — the cell size is the mount's width over
 * its columns, measured, never a constant — and only for a row that is on
 * screen; a click can only land on one that is. Off-screen, and before the
 * terminal has been laid out, the caller's fallback stands in: the pointer's
 * own position, which is where the click was whatever the buffer says.
 *
 * `.xterm-screen` is what travels with the box, not `mount`. It sits *inside*
 * `.xterm-viewport`, which is the element that actually scrolls when output
 * arrives, so a panel anchored here can ask "did that scroll move me" and get
 * the right answer — where the mount, being the viewport's parent, would say
 * no to the one scroll that does move it.
 */
function cellAnchor(
  term: Terminal,
  mount: HTMLElement,
  start: number,
  end: number,
  bufferRow: number,
  fallback: Box
): PopoverAnchor {
  const screen = mount.querySelector<HTMLElement>('.xterm-screen');
  const within = screen ?? mount;
  if (!screen || term.cols === 0 || term.rows === 0) return { box: fallback, within };
  const rect = screen.getBoundingClientRect();
  const cellW = rect.width / term.cols;
  const cellH = rect.height / term.rows;
  const viewportRow = bufferRow - term.buffer.active.viewportY;
  if (viewportRow < 0 || viewportRow >= term.rows) return { box: fallback, within };
  return {
    box: {
      left: rect.left + start * cellW,
      right: rect.left + end * cellW,
      top: rect.top + viewportRow * cellH,
      bottom: rect.top + (viewportRow + 1) * cellH
    },
    within
  };
}
