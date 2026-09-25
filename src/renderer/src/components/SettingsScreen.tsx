import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { StatlineFigures } from '@shared/statline';
import type { TerminalPalette } from '@shared/themes';
import SettingsNav from './SettingsNav';
import CharacterForm, { CHARACTER_NAV } from './CharacterForm';
import ServerForm from './ServerForm';
import FormActions from './FormActions';
import GlobalSettings from './GlobalSettings';

import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import {
  begin,
  canRedo,
  canUndo,
  historyIntent,
  record,
  redo,
  replace,
  sameJson,
  targetOf,
  undo,
  type History
} from '../lib/history';
import {
  copyOf,
  draftOf,
  emptyForm,
  formOf,
  sameForm,
  type CharacterFields,
  type CharacterSection
} from '../lib/characterForm';
import { emptyServerForm } from '../lib/serverForm';
import { withLoopToggled } from '../lib/loops';
import { useAutoSave } from '../hooks/useAutoSave';
import { useCharacterRealm, type CharacterRealmLoaders } from '../hooks/useCharacterRealm';
import { useSettingsPanel } from '../hooks/useSettingsPanel';
import type { GlobalDraft, ProfileDraft, ServerDraft } from '@shared/drafts';
import type { Loop, ScopedLoop } from '@shared/loops';
import type { SessionId, SettingsSnapshot } from '@shared/ipc';
import { DEFAULT_CONFIG } from '@shared/config';
import { errorMessage } from '@shared/values';

export interface SettingsScreenProps extends CharacterRealmLoaders {
  open: boolean;
  /**
   * Which character to open on: a profile id, {@link SETTINGS_NEW_CHARACTER},
   * or `null` for wherever it was left.
   *
   * A string rather than an object on purpose. This drives the effect that runs
   * when the dialog opens, and an object literal from a caller would be a new
   * value every render — which is the trap that made a refused save flash and
   * vanish before anybody could read it.
   */
  openAt?: string | null;
  /**
   * What a character's percentage thresholds are percentages *of*.
   *
   * A function rather than a value: the screen edits one character at a time
   * but is opened from anywhere, and the figures belong to the character being
   * edited rather than to whichever one is on screen. Both halves are null for
   * a character not in the realm, and `figureOf` draws that as nothing — an
   * unknown maximum has never been a number in this client.
   */
  maximaFor(session: SessionId): { hpMax: number | null; manaMax: number | null };
  /**
   * The figures the designed status line is previewed with — the character's
   * own while it is in the realm, else null and the designer draws a sample.
   */
  figuresFor(session: SessionId): StatlineFigures | null;
  /** The console's palette, which that preview is drawn against. */
  palette: TerminalPalette;
  /**
   * There is nowhere to go back to, so there is no way out of this screen.
   *
   * A client with no characters exists only to make one: there is no console,
   * no rail and no tab behind this dialog, and the version that could be
   * dismissed left somebody looking at an empty window with no way of guessing
   * what to do next. So while this is set the close glyph is not drawn, Escape
   * and the scrim do nothing, and the screen says why in one line.
   *
   * A prop rather than `characters.length === 0` read here: the screen loads
   * its own snapshot asynchronously, and the moment before that lands it would
   * be indistinguishable from a client with no characters — which is precisely
   * the state that must not be got wrong in the direction of *un*closeable.
   */
  required?: boolean;
  onClose(): void;
  load(): Promise<SettingsSnapshot>;
  saveProfile(id: string, draft: ProfileDraft): Promise<string | null>;
  deleteProfile(id: string): Promise<string | null>;
  saveServer(previousName: string | null, draft: ServerDraft): Promise<string | null>;
  deleteServer(name: string): Promise<string | null>;
  /** Writes the options file everything is inherited from. */
  saveGlobal(draft: GlobalDraft): Promise<string | null>;
  revealConfig(): void;
  revealProfiles(): void;
  /** Native picker for a realm database. Resolves to null if dismissed. */
  chooseRealm(): Promise<string | null>;
  /**
   * The loops the client ships, for the Movement tab to offer.
   *
   * Asked for when the shelf is opened rather than with the settings snapshot:
   * it is four hundred loops, and most visits to this screen are about a
   * password. Resolves to an empty list rather than throwing — an empty shelf
   * is a package missing its data, and a hand-written loop still works.
   */
  loadLoops(): Promise<Loop[]>;
}

/**
 * A character that has not been created yet.
 *
 * Exported so the `+` at the head of the tab rail can ask for it by name rather
 * than opening the screen and hoping it lands somewhere useful. The NUL keeps
 * it out of the space of real profile ids, which are filenames.
 */
export const SETTINGS_NEW_CHARACTER = '\u0000new';
const NEW_CHARACTER = SETTINGS_NEW_CHARACTER;
const NEW_SERVER = '\u0000new-server';

/**
 * Open straight to the realms list, rather than to a character.
 *
 * A realm is not a character's own setting — it has a directory of its own
 * because more than one character plays on the same one — so a command wanting
 * to add or edit one has no character id to name. Exported for the same reason
 * {@link SETTINGS_NEW_CHARACTER} is: a caller asks for this screen by what it
 * wants to land on, not by opening it and hoping.
 */
export const SETTINGS_MANAGE_SERVERS = '\u0000servers';

/**
 * Open on the client's own settings — the MudEngine page.
 *
 * How the client itself behaves: the console, the theme, the tabs, the records
 * it keeps. Reached from the gear at the head of the tab rail, from the
 * palette, and by the crumb here; a sentinel like the two above, for the same
 * reason.
 */
export const SETTINGS_GLOBAL = '\u0000global';

/**
 * Open on the Global page — what a new realm and a new character start with.
 *
 * A separate door from {@link SETTINGS_GLOBAL} because they are separate
 * questions: "make the console bigger" and "stop every new character resting
 * at 60%" have nothing to do with each other, and one page holding both is the
 * reason neither could be found.
 */
export const SETTINGS_DEFAULTS = '\u0000defaults';

/**
 * The two pages that draw `global/default.yaml`.
 *
 * One file, two audiences: `client` is MudEngine — how the client itself
 * behaves — and `defaults` is Global, the values a new realm and a new
 * character start from. They share a draft and a save, because a page that
 * wrote half a file would be a second writer for it.
 */
type GlobalTab = 'client' | 'defaults';

/** Whether this page is one of the two drawing the options file. */
function showsGlobal(tab: string): tab is GlobalTab {
  return tab === 'client' || tab === 'defaults';
}

/**
 * Creating and editing characters and servers, without opening a text editor.
 *
 * The command strip was removed because a host and a port describe a
 * *character* and not the client, and that information moved into
 * `profiles/*.yaml` — which is fine for somebody who edits YAML and is not fine
 * as the only way in. This is the way in.
 *
 * Deliberately **not** an editor for the whole options file. A profile is a
 * sparse overlay that may carry `automation:` and `ui:` blocks, and YAML is
 * genuinely good at those: they are lists of rules with comments explaining
 * why. What YAML is bad at is a password, a port and a menu answer, and that is
 * what this covers. The screen says where the files are so the rest stays one
 * click away.
 *
 * The character form's sections, and the rule a new one has to pass, are
 * `CharacterForm`'s.
 *
 * A dialog that takes typed input, so it honours the focus policy: it holds the
 * caret while open and hands it back to the terminal on any exit.
 */
export default function SettingsScreen({
  open,
  openAt = null,
  maximaFor,
  figuresFor,
  palette,
  required = false,
  onClose,
  load,
  saveProfile,
  deleteProfile,
  saveServer,
  deleteServer,
  saveGlobal,
  revealConfig,
  revealProfiles,
  chooseRealm,
  loadLoops,
  loadTrainers,
  loadBanks,
  loadServing,
  loadWards,
  loadMobNames
}: SettingsScreenProps) {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
  /**
   * Which of the four pages is showing.
   *
   * `client` is MudEngine and `defaults` is Global: two views of one file, so
   * they share a draft, a form and a save. See `GlobalSettings`.
   */
  const [tab, setTab] = useState<GlobalTab | 'characters' | 'servers'>('characters');
  const [selected, setSelected] = useState<string | null>(null);
  /**
   * The character form, and every step back from it.
   *
   * A `History` rather than a bare value because the Save button is gone: what
   * somebody typed is saved on its own, so the way back has to be a control
   * rather than "close without saving". `form` is the present; `loadForm`
   * starts a fresh history (opening a character is not something to undo into)
   * and `edit` records a step.
   */
  const [history, setHistory] = useState<History<CharacterFields> | null>(null);
  const form = history?.present ?? null;
  /**
   * Which part of a character's own form is showing.
   *
   * The character form outgrew one scroll: a name and a server share nothing
   * with a hang-up threshold, and finding either meant scrolling past fields
   * that were not it. Split along what the fields actually are — identity and
   * connection, the login menus, auto-combat and the two safety nets — rather
   * than inventing sections for settings this screen does not hold. Attack
   * *rules* and spells stay in `automation.rules`, on purpose: see
   * `CharacterForm`'s comment for the test a section has to pass.
   */
  const [section, setSection] = useState<CharacterSection>('profile');
  /**
   * Whether the shelf of shipped loops is open, and what is on it.
   *
   * The catalogue is read once per visit to this screen and kept: it is four
   * hundred loops out of a file inside the application, so it cannot change
   * while the screen is open, and re-asking on every keystroke in the search
   * field would be a query per character typed.
   */
  /**
   * Which character a new one is being started from, if any.
   *
   * Held rather than left as a write-once select, so the control keeps saying
   * what it did. A select that snapped back to "start empty" the moment it was
   * used would read as one that had not worked.
   */
  const [copyFrom, setCopyFrom] = useState('');
  const [picking, setPicking] = useState(false);
  const [catalogue, setCatalogue] = useState<Loop[] | null>(null);
  const [serverPick, setServerPick] = useState<string | null>(null);
  /** The server form, with the same way back the character form has. */
  const [serverHistory, setServerHistory] = useState<History<ServerDraft> | null>(null);
  const serverForm = serverHistory?.present ?? null;
  /**
   * The options file, as a form holds it.
   *
   * Kept beside the character and server forms rather than inside
   * `GlobalSettings`, so a refused save can put the error where the other two
   * put theirs and a reload after saving can hand back what is now on disk.
   */
  const [globalHistory, setGlobalHistory] = useState<History<GlobalDraft> | null>(null);
  const globalForm = globalHistory?.present ?? null;
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  /* Where the player dragged it, and the two gestures that move it. */
  const panel = useSettingsPanel();
  const firstFieldRef = useRef<HTMLInputElement>(null);

  /**
   * Puts a form on screen without making it a step.
   *
   * Opening a character, starting a blank one, copying from one: none of those
   * is an edit, and a history that recorded them would let an undo pull another
   * character's fields onto the screen under this one's name.
   */
  const loadForm = useCallback((value: CharacterFields | null): void => {
    setHistory(value === null ? null : begin(value));
  }, []);

  /*
   * The same pair for the other two forms. `set*` records a step, `load*`
   * starts a fresh history -- and every call site below reads as it did, which
   * is the point: what changed is what the setter *means*, not who calls it.
   */
  const setServerForm = useCallback((next: ServerDraft): void => {
    setServerHistory((current) => (current ? record(current, next, sameJson) : begin(next)));
    setSaved(null);
  }, []);

  const loadServerForm = useCallback((value: ServerDraft | null): void => {
    setServerHistory(value === null ? null : begin(value));
  }, []);

  const setGlobalForm = useCallback((next: GlobalDraft): void => {
    setGlobalHistory((current) => (current ? record(current, next, sameJson) : begin(next)));
    setSaved(null);
  }, []);

  const loadGlobalForm = useCallback((value: GlobalDraft | null): void => {
    setGlobalHistory(value === null ? null : begin(value));
  }, []);

  const refresh = useCallback(async (): Promise<SettingsSnapshot> => {
    const next = await load();
    setSnapshot(next);
    return next;
  }, [load]);

  /*
   * Runs when the dialog *opens*, and only then.
   *
   * Keyed on `open` alone. It used to depend on `refresh`, which depends on the
   * `load` prop — and a caller passing an inline arrow makes that a new function
   * every render, so this ran on every render and cleared the message it had
   * just been given. A refused save flashed and vanished, which reads exactly
   * like a save that silently did nothing.
   */
  useEffect(() => {
    if (!open) return;
    setProblem(null);
    setSaved(null);
    setConfirming(null);
    const opened = refresh().then((next) => {
      /*
       * Asked for by name — a tab's own menu, or the `+` beside the tabs.
       *
       * The form is set here rather than left to the effect below, which stands
       * down while one is already loaded. Arriving from a tab menu with the
       * previous character's fields still in state would put that character's
       * username and server under this one's heading, and the first thing
       * anybody would do is save it.
       */
      // Every branch below lands on a character's Profile section, if it
      // lands on a character at all -- the last section viewed belongs to the
      // character it was viewed on, not to whichever one opens next.
      setSection('profile');

      /*
       * The client's own settings, which are neither a character nor a server.
       * Loaded here rather than left to an effect, for the reason above: what
       * is on the form has to be what the heading says it is.
       */
      if (openAt === SETTINGS_GLOBAL || openAt === SETTINGS_DEFAULTS) {
        setTab(openAt === SETTINGS_GLOBAL ? 'client' : 'defaults');
        loadGlobalForm(next.global);
        return;
      }

      // A realm, not a character: the realms page has no id space to search, so
      // it is checked by its own sentinel rather than falling through to the
      // character lookup below.
      if (openAt === SETTINGS_MANAGE_SERVERS) {
        setTab('servers');
        setServerPick(next.servers[0]?.name ?? NEW_SERVER);
        loadServerForm(
          next.servers[0]
            ? { ...next.servers[0], loops: next.loops.servers[next.servers[0].name] ?? [] }
            : emptyServerForm(next.global)
        );
        return;
      }

      if (openAt === NEW_CHARACTER) {
        setTab('characters');
        setSelected(NEW_CHARACTER);
        setCopyFrom('');
        loadForm(emptyForm(next.servers, next.global));
        return;
      }
      const asked = openAt === null ? undefined : next.characters.find((e) => e.id === openAt);
      if (asked) {
        setTab('characters');
        setSelected(asked.id);
        loadForm(formOf(asked));
        return;
      }

      /*
       * Open on something.
       *
       * A settings screen that opens to an empty pane is a dead end — there is
       * nothing to read and nowhere for the caret to go, which also means the
       * dialog holds no focus and the focus policy has nothing to hand back.
       * The first character is the useful default; with none, the new-character
       * form is.
       *
       * This is also where a character asked for by name but *deleted* between
       * the click and the open lands: opening normally beats opening a blank
       * form wearing a name that no longer exists.
       */
      setSelected((current) => current ?? next.characters[0]?.id ?? NEW_CHARACTER);
    });
    // A failed load lands in the slot every other refusal uses, rather than
    // leaving the dialog on its loading state with nothing to read.
    void opened.catch((error) => setProblem(errorMessage(error)));
  }, [open, openAt]);

  // Follows `selected` once the snapshot has arrived, including the automatic
  // choice above.
  useEffect(() => {
    if (!open || selected === null || form !== null) return;
    if (selected === NEW_CHARACTER) {
      return loadForm(emptyForm(snapshot?.servers ?? [], snapshot?.global ?? null));
    }
    const found = snapshot?.characters.find((entry) => entry.id === selected);
    if (found) loadForm(formOf(found));
  }, [open, selected, form, snapshot]);

  useEffect(() => {
    if (!open) return;
    const id = window.requestAnimationFrame(() => firstFieldRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [open, selected, tab]);

  // Follows the snapshot the same way the character form does, and stands down
  // once a form is loaded so it cannot discard what somebody is typing.
  useEffect(() => {
    if (!open || !showsGlobal(tab) || globalForm !== null || snapshot === null) return;
    loadGlobalForm(snapshot.global);
  }, [open, tab, globalForm, snapshot, loadGlobalForm]);

  const characters = snapshot?.characters ?? [];
  const servers = useMemo(() => snapshot?.servers ?? [], [snapshot]);
  /** The loops each server lends its characters, keyed by the name they use. */
  const serverLoops = useMemo(() => snapshot?.loops.servers ?? {}, [snapshot]);
  /**
   * What the character on screen walks without asking: its server's loops, then
   * the global ones.
   *
   * Off the character rather than off the snapshot, because it depends on which
   * server this one plays on — and shown rather than edited here, since scope
   * is the directory a loop file sits in and a tick box on a character's page
   * cannot move one.
   */
  const inheritedLoops = useMemo<ScopedLoop[]>(
    () =>
      selected === null || selected === NEW_CHARACTER
        ? (snapshot?.loops.global.map((loop) => ({ loop, scope: 'global' as const })) ?? [])
        : (snapshot?.characters.find((entry) => entry.id === selected)?.inherited ?? []),
    [snapshot, selected]
  );

  /*
   * Saving, without anybody having to say so.
   *
   * The Save button was the last thing on this screen that could be forgotten,
   * and forgetting it is silent: the form goes on showing what was typed, so a
   * change somebody meant to make and one they made look identical until the
   * next launch.
   *
   * **Only while editing something that already exists.** Creating still takes
   * a press, and that is not a compromise: a half-typed name is a *different*
   * file, so an auto-saved new character would write `profiles/f/`,
   * `profiles/fr/`, `profiles/fre/` -- a directory per keystroke, none of them
   * what anybody meant.
   */
  const editingCharacter = selected !== null && selected !== NEW_CHARACTER;
  const characterSave = useAutoSave<CharacterFields>({
    value: form,
    identity: selected,
    enabled: open && tab === 'characters' && editingCharacter,
    same: sameForm,
    save: async (value) => {
      const refusal = await saveProfile(selected ?? '', draftOf(value));
      // Only on success: a refused save leaves the list describing what is
      // still on disk, which is the truth.
      if (refusal === null) await refresh();
      return refusal;
    }
  });

  const editingServer = serverPick !== null && serverPick !== NEW_SERVER;
  const serverSave = useAutoSave<ServerDraft>({
    value: serverForm,
    identity: serverPick,
    enabled: open && tab === 'servers' && editingServer,
    same: sameJson,
    save: async (value) => {
      const refusal = await saveServer(serverPick, value);
      if (refusal !== null) return refusal;
      /*
       * The selection follows the name as it is typed.
       *
       * `saveServer` matches on the *previous* name to find the directory, and
       * without this the second keystroke of a rename would look up a name
       * that no longer exists on disk and make a second server beside the
       * first -- one per keystroke, which is the same failure creating has.
       *
       * Only while that realm is still the one on screen. `chooseServer`
       * flushes this save on its way to another realm, and the answer lands
       * after the switch; following the name then would drag the selection
       * back to the realm somebody just left.
       */
      setServerPick((current) => (current === serverPick ? value.name : current));
      await refresh();
      return null;
    }
  });

  const globalSave = useAutoSave<GlobalDraft>({
    value: globalForm,
    // There is exactly one options file, so the identity never changes.
    identity: 'global',
    // Always, once it is loaded: there is exactly one options file and it
    // always exists, so there is no creating case to keep out of.
    enabled: open && showsGlobal(tab) && globalForm !== null,
    same: sameJson,
    save: async (value) => {
      const refusal = await saveGlobal(value);
      if (refusal === null) await refresh();
      return refusal;
    }
  });

  /** Opening a character loads its fields; opening "new" starts an empty one. */
  const choose = useCallback(
    (id: string | null) => {
      /*
       * Whatever is still waiting out the debounce is this character's, and
       * the switch below would otherwise discard it: the timer is cleared
       * when the identity changes, and an edit younger than the delay was
       * silently lost, exactly as it would have been saved. Before
       * `setSelected`, so the save still knows whose file it is.
       */
      characterSave.flush();
      setSelected(id);
      setProblem(null);
      setSaved(null);
      setConfirming(null);
      // Every character opens on Profile. Landing wherever the last one was
      // left would show, say, the hang-up threshold under a name that has
      // nothing to do with it -- the same trap `openAt` exists to avoid one
      // level up.
      setSection('profile');
      // Putting the shelf away with the character it was opened over: a picker
      // still showing when a different name arrives is a picker whose "added"
      // ticks describe somebody else.
      setPicking(false);
      setCopyFrom('');
      if (id === null) return loadForm(null);
      if (id === NEW_CHARACTER) return loadForm(emptyForm(servers, snapshot?.global ?? null));
      const found = characters.find((entry) => entry.id === id);
      loadForm(found ? formOf(found) : null);
    },
    [characters, servers, snapshot, characterSave.flush]
  );

  /**
   * Opens the shelf, reading the catalogue the first time it is asked for.
   *
   * Lazily and once. A settings visit is usually about a password, and four
   * hundred loops are not worth carrying across the boundary for one; a file
   * inside the application cannot change while the screen is open, so once is
   * also enough.
   */
  const openPicker = useCallback(() => {
    setPicking(true);
    if (catalogue !== null) return;
    void loadLoops().then(
      (loops) => setCatalogue(loops),
      // An empty shelf, said by the picker itself. A catalogue that could not be
      // read is not a reason to refuse the save the person came here to make.
      () => setCatalogue([])
    );
  }, [catalogue, loadLoops]);

  /** Puts a loop on this character, or takes it off — see `withLoopToggled`. */
  const toggleLoop = useCallback((loop: Loop) => {
    // An edit like any other, so it steps back like one.
    setHistory((current) => withLoopToggled(current, loop, sameForm));
    setSaved(null);
  }, []);

  /** And on the client's own page: the loops every character walks. */
  const toggleGlobalLoop = useCallback((loop: Loop) => {
    setGlobalHistory((current) => withLoopToggled(current, loop, sameJson));
    setSaved(null);
  }, []);

  /** The same gesture on a server's page: its loops, everyone who plays there. */
  const toggleServerLoop = useCallback((loop: Loop) => {
    setServerHistory((current) => withLoopToggled(current, loop, sameJson));
    setSaved(null);
  }, []);

  const chooseServer = useCallback(
    (name: string | null) => {
      // The same as `choose`: the last second of typing goes to the realm it
      // was typed into, not into the bin.
      serverSave.flush();
      setServerPick(name);
      setProblem(null);
      setSaved(null);
      setConfirming(null);
      // The shelf goes with the server it was opened over: a picker still
      // showing when a different name arrives is one whose ticks describe
      // somebody else.
      setPicking(false);
      if (name === null) return loadServerForm(null);
      if (name === NEW_SERVER) return loadServerForm(emptyServerForm(snapshot?.global ?? null));
      const found = servers.find((entry) => entry.name === name);
      // The loops come from the tree rather than from the realm entry: they
      // are files beside it, and the entry is only what its own file says.
      loadServerForm(found ? { ...found, loops: serverLoops[name] ?? [] } : null);
    },
    [servers, serverLoops, snapshot, serverSave.flush]
  );

  /**
   * Jump to the servers list from wherever the dialog currently is.
   *
   * Lands on the first server rather than an empty list: the same "open on
   * something" rule the character tab follows, and for the same reason -- a
   * pane with nothing selected holds no focusable field, which is a dead end
   * for a dialog that is supposed to hand the caret straight to a field. With
   * none at all it lands on the add-a-server form instead, which does.
   */
  const goToServers = useCallback(() => {
    setTab('servers');
    chooseServer(servers[0]?.name ?? NEW_SERVER);
  }, [servers, chooseServer]);

  /**
   * Open MudEngine or Global, both of which draw the options file.
   *
   * The form is loaded here rather than left to the effect that follows `tab`:
   * that effect stands down while one is already loaded, which is what keeps
   * it from discarding what somebody is typing — so arriving with a stale
   * draft would show the *previous* values under this heading, and the first
   * thing anybody would do is save them.
   */
  const openGlobal = useCallback(
    (which: GlobalTab) => {
      setTab(which);
      setProblem(null);
      setSaved(null);
      setPicking(false);
      if (snapshot !== null) loadGlobalForm(snapshot.global);
    },
    [snapshot, loadGlobalForm]
  );

  /** Whichever form is on screen: its way back, and how its saving is going. */
  const active = useMemo(() => {
    if (showsGlobal(tab)) {
      return {
        save: globalSave,
        can: {
          undo: globalHistory !== null && canUndo(globalHistory),
          redo: globalHistory !== null && canRedo(globalHistory)
        },
        undo: () => setGlobalHistory((current) => (current ? undo(current) : current)),
        redo: () => setGlobalHistory((current) => (current ? redo(current) : current))
      };
    }
    if (tab === 'servers') {
      return {
        save: serverSave,
        can: {
          undo: serverHistory !== null && canUndo(serverHistory),
          redo: serverHistory !== null && canRedo(serverHistory)
        },
        undo: () => setServerHistory((current) => (current ? undo(current) : current)),
        redo: () => setServerHistory((current) => (current ? redo(current) : current))
      };
    }
    return {
      save: characterSave,
      can: {
        undo: history !== null && canUndo(history),
        redo: history !== null && canRedo(history)
      },
      undo: () => setHistory((current) => (current ? undo(current) : current)),
      redo: () => setHistory((current) => (current ? redo(current) : current))
    };
  }, [tab, globalSave, serverSave, characterSave, globalHistory, serverHistory, history]);

  /**
   * Closing does not lose the last second of typing.
   *
   * The write is debounced, so there is always a moment where what is on screen
   * is newer than what is on disk — and closing the dialog is exactly when
   * somebody stops typing. Flushed rather than left to the timer, which is gone
   * the moment this unmounts.
   */
  const close = (): void => {
    // The one way out is making a character. Refused here rather than only at
    // each of the three doors, so a fourth added later cannot forget.
    if (required) return;
    active.save.flush();
    onClose();
  };

  /* What the realm says about the character on screen, for the form's pickers. */
  const realm = useCharacterRealm(
    open && tab === 'characters',
    section,
    selected === null || selected === NEW_CHARACTER ? null : selected,
    { loadTrainers, loadBanks, loadServing, loadWards, loadMobNames }
  );

  if (!open) return null;

  /*
   * What this character's thresholds are percentages of.
   *
   * `NEW_CHARACTER` has no session and therefore no maxima, which is right
   * rather than merely tolerated: a character that has never been in the realm
   * has no hit points to state, and `figureOf` draws that as nothing.
   */
  const maxima =
    selected !== null && selected !== NEW_CHARACTER
      ? maximaFor(selected)
      : { hpMax: null, manaMax: null };
  // And the whole of them, for the status line's preview; the designer draws a
  // sample for a character that is not in the realm.
  const figures = selected !== null && selected !== NEW_CHARACTER ? figuresFor(selected) : null;
  /*
   * What each threshold's bar is drawn on: the **inherited** vitals bands.
   *
   * From the Global draft rather than from `DEFAULT_CONFIG`: the character page
   * has no vitals section, so what a character runs on is what the options file
   * says, and a player who moved caution to 70% must not be shown 60% in green
   * here and amber on their own HUD. Falls back to the shipped bands only while
   * the snapshot has not landed.
   */
  const bands = snapshot?.global.ui.vitals ?? DEFAULT_CONFIG.ui.vitals;

  const patch = (change: Partial<CharacterFields>): void => {
    setHistory((current) =>
      current === null ? current : record(current, { ...current.present, ...change }, sameForm)
    );
    setSaved(null);
  };

  const submitCharacter = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!form) return;
    setProblem(null);
    setSaved(null);

    const id = (selected === NEW_CHARACTER ? form.id : selected) ?? '';
    const draft = draftOf(form);

    const error = await saveProfile(id, draft);
    if (error !== null) return setProblem(error);
    const next = await refresh();
    setSaved(t('settings.characters.saved', { characterName: form.name || id }));
    // A character just created is the one you want open.
    setSelected(id);
    const found = next.characters.find((entry) => entry.id === id);
    // What came back from disk, not a step: recording it would put a move in
    // the history that nobody made.
    if (found)
      setHistory((current) => (current ? replace(current, formOf(found)) : begin(formOf(found))));
  };

  const submitServer = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!serverForm) return;
    setProblem(null);
    setSaved(null);
    const previous = serverPick === NEW_SERVER ? null : serverPick;
    const error = await saveServer(previous, serverForm);
    if (error !== null) return setProblem(error);
    await refresh();
    setSaved(t('settings.realms.saved', { realmName: serverForm.name }));
    setServerPick(serverForm.name);
  };

  const submitGlobal = async (): Promise<void> => {
    if (!globalForm) return;
    setProblem(null);
    setSaved(null);
    const error = await saveGlobal(globalForm);
    if (error !== null) return setProblem(error);
    const next = await refresh();
    /*
     * What came back from disk, and not a step: the password fields are
     * cleared by the round trip, which is what stops a second save re-sending
     * one nobody retyped — but nothing here is a move somebody made, so the
     * way back is left as it was.
     */
    setGlobalHistory((current) => (current ? replace(current, next.global) : begin(next.global)));
    setSaved(t('settings.global.saved'));
  };

  const remove = async (): Promise<void> => {
    if (selected === null || selected === NEW_CHARACTER) return;
    const error = await deleteProfile(selected);
    if (error !== null) return setProblem(error);
    await refresh();
    choose(null);
    setSaved(t('settings.characters.removed'));
  };

  const removeServer = async (): Promise<void> => {
    if (serverPick === null || serverPick === NEW_SERVER) return;
    const error = await deleteServer(serverPick);
    if (error !== null) return setProblem(error);
    await refresh();
    chooseServer(null);
    setSaved(t('settings.realms.removed'));
  };

  /* Starting a new character from one that already works: see `copyOf`. */
  const copyCharacter = (value: string): void => {
    setCopyFrom(value);
    setProblem(null);
    setSaved(null);
    const found = characters.find((entry) => entry.id === value);
    // Back to empty is a real answer, and it has to undo what choosing did or
    // the control is one-way.
    loadForm(found ? copyOf(found) : emptyForm(servers, snapshot?.global ?? null));
  };

  const shelf = {
    catalogue,
    picking,
    onOpenPicker: openPicker,
    onDonePicking: () => setPicking(false)
  };

  return (
    /*
     * A layer over the workspace, not a modal over a scrim.
     *
     * The scrim took every click and the dialog took the whole window, so a
     * setting could not be changed and *watched*: whatever it does happens in
     * the console behind it, sometimes while a character is standing somewhere
     * being hit. The layer passes the pointer through to the console
     * (`pointer-events: none`, the panel itself takes them back), the panel is
     * moved by its heading and resized from its corner, and the two ways out
     * are the close glyph and Escape while it holds the caret.
     *
     * The one exception is the state with no characters at all: there is
     * nothing behind the screen to reach and nothing to type at, so it keeps
     * the scrim, keeps `aria-modal`, and keeps having no way out.
     */
    <div className="settings-layer" data-required={required ? 'true' : 'false'} role="presentation">
      <div
        aria-label={t('settings.dialog.ariaLabel')}
        aria-modal={required ? 'true' : undefined}
        className="surface settings"
        data-dragging={panel.dragging ? 'true' : 'false'}
        data-placed={!required && panel.placed ? 'true' : 'false'}
        style={required ? undefined : panel.style}
        onKeyDown={(event) => {
          /*
           * The dialog owns its own Escape.
           *
           * A window-level hotkey cannot serve this: `useHotkeys` listens in
           * capture and stands down for an unmodified key while the caret is in
           * a chrome text field — which is exactly the state this dialog is
           * normally in, because it is a form. A surface that holds the caret
           * owns its keys, and Escape most of all: this one holds the keyboard
           * while a character is standing somewhere.
           */
          /*
           * Undo and redo, on whichever chord the hands know.
           *
           * `Cmd Shift Z` is the macOS redo, `Ctrl Y` the Windows one, and
           * `Ctrl Shift Z` is understood everywhere — all three are accepted,
           * because somebody arriving from another application presses theirs
           * and a chord that silently does nothing reads as a feature that is
           * not there. It stands down while the caret is in a text field,
           * where `Ctrl Z` is the field's own undo and works a character at a
           * time; the buttons stay reachable there. See `historyIntent`.
           */
          const intent = historyIntent(event, targetOf(event.target));
          if (intent !== null) {
            event.preventDefault();
            if (intent === 'undo') active.undo();
            else active.redo();
            return;
          }

          if (event.key !== 'Escape') return;
          event.preventDefault();
          // One Escape, one step, innermost first, so the key never does
          // something bigger than expected. The loop shelf is not in this
          // list: it holds the caret while it is open and stops the event
          // before it reaches here, which is the same rule stated from the
          // other side — a bare key belongs to whatever holds the caret.
          if (confirming !== null) return setConfirming(null);
          close();
        }}
        role="dialog"
      >
        {/*
          The heading is the handle, as a card's is. `onPointerDown` and not a
          separate grip: the row is already the thing anybody grabs, and the
          controls in it (the four crumbs, the close glyph) stop the press
          themselves rather than the row testing what was under the pointer.
        */}
        <header
          className="settings-head"
          onDoubleClick={required ? undefined : panel.reset}
          onPointerDown={required ? undefined : panel.move}
        >
          {/*
            General to particular, left to right: the client, then what a new
            realm and a new character start from, then the realms, then the
            characters. Somebody arriving to change a password walks the whole
            row to get there, which is right -- the row is also the sentence
            that explains how the four relate.

            No separator between them. A pill already has an edge, and a glyph
            between two of them doubles the seam instead of marking it --
            CLAUDE.md, "A card's faces live in its heading". This heading is
            the same control as a card's faces and had kept its `›`.
          */}
          <h2>
            <button
              className="crumb"
              data-active={tab === 'client' ? 'true' : 'false'}
              onClick={() => openGlobal('client')}
              onMouseDown={keepFocus}
              onPointerDown={stopDrag}
              type="button"
            >
              {t('settings.crumbs.mudEngine')}
            </button>
            <button
              className="crumb"
              data-active={tab === 'defaults' ? 'true' : 'false'}
              onClick={() => openGlobal('defaults')}
              onMouseDown={keepFocus}
              onPointerDown={stopDrag}
              type="button"
            >
              {t('settings.crumbs.global')}
            </button>
            <button
              className="crumb"
              data-active={tab === 'servers' ? 'true' : 'false'}
              /*
               * `goToServers`, not `setTab`. There are two doors onto this list
               * -- this crumb and the palette's `Settings: add or edit a
               * realm...` -- and only one of them was landing on a realm. The
               * other showed "Choose a realm, or add one." over a list of one,
               * which is a dead screen with no focusable field in it.
               */
              onClick={goToServers}
              onMouseDown={keepFocus}
              onPointerDown={stopDrag}
              type="button"
            >
              {t('settings.crumbs.realms')}
            </button>
            <button
              className="crumb"
              data-active={tab === 'characters' ? 'true' : 'false'}
              onClick={() => setTab('characters')}
              onMouseDown={keepFocus}
              onPointerDown={stopDrag}
              type="button"
            >
              {t('settings.crumbs.characters')}
            </button>
          </h2>
          {/*
            Absent rather than disabled while there is no character: a greyed
            close is a control that says *later*, and there is no later here —
            the way out is the form beside it.
          */}
          {!required && (
            <button
              aria-label={t('settings.dialog.closeAria')}
              className="quiet"
              onClick={close}
              onPointerDown={stopDrag}
              type="button"
            >
              ✕
            </button>
          )}
        </header>

        {/*
          Said out loud, and standing rather than as a refusal that only appears
          when somebody presses Escape: the whole failure here was a screen that
          could be dismissed onto an empty window, so the sentence has to be
          readable *before* anybody tries the way out that is gone.
        */}
        {required && <p className="settings-warn">{t('settings.dialog.characterRequired')}</p>}

        <div className="settings-body" data-tab={tab}>
          {showsGlobal(tab) ? (
            globalForm === null ? (
              <div className="settings-form empty">{t('settings.global.loading')}</div>
            ) : (
              <GlobalSettings
                catalogue={catalogue}
                draft={globalForm}
                palette={palette}
                scope={tab}
                firstFieldRef={firstFieldRef}
                realmSpells={snapshot?.realmSpells ?? []}
                onChange={(next) => {
                  setGlobalForm(next);
                  setSaved(null);
                }}
                onDonePicking={() => setPicking(false)}
                onOpenPicker={openPicker}
                actions={
                  <FormActions
                    can={active.can}
                    error={active.save.error}
                    onRedo={active.redo}
                    onUndo={active.undo}
                    state={active.save.state}
                  />
                }
                onSubmit={() => void submitGlobal()}
                onToggleLoop={toggleGlobalLoop}
                picking={picking}
              />
            )
          ) : tab === 'characters' ? (
            <>
              {/*
                Which character, then which part of it, then the fields: the
                rail asks the two questions in the order they are answered, and
                the form keeps the whole of the other column (todo 02).
              */}
              <SettingsNav
                onSection={(id: string) => setSection(id as CharacterSection)}
                picker={{
                  addId: NEW_CHARACTER,
                  addLabel: t('settings.characters.new'),
                  choices: characters.map((entry) => ({
                    id: entry.id,
                    name: entry.name,
                    detail: entry.error
                      ? t('settings.characters.cannotLoad')
                      : (entry.serverName ?? entry.target.host),
                    accent: entry.accent,
                    broken: entry.error !== undefined
                  })),
                  chosen: selected,
                  label: t('settings.nav.character'),
                  onChoose: (id: string) => choose(id)
                }}
                section={section}
                sections={CHARACTER_NAV}
              />

              {form === null ? (
                <div className="settings-form empty">
                  {characters.length === 0
                    ? t('settings.characters.emptyNone')
                    : t('settings.characters.emptyChoose')}
                </div>
              ) : (
                <CharacterForm
                  actions={
                    <>
                      {/*
                        Creating still takes a press; editing does not.
                        A half-typed file name is a *different* character, so an
                        auto-saved new one would write a directory per keystroke.
                      */}
                      {selected === NEW_CHARACTER ? (
                        <button className="primary" type="submit">
                          {t('settings.actions.createCharacter')}
                        </button>
                      ) : (
                        <FormActions
                          can={active.can}
                          error={active.save.error}
                          onRedo={active.redo}
                          onUndo={active.undo}
                          state={active.save.state}
                        />
                      )}
                      {selected !== NEW_CHARACTER &&
                        (confirming === selected ? (
                          <>
                            <span className="hint">
                              {t('settings.actions.confirmRemoveCharacter')}
                            </span>
                            <button className="danger" onClick={() => void remove()} type="button">
                              {t('settings.actions.confirmYes')}
                            </button>
                            <button
                              className="quiet"
                              onClick={() => setConfirming(null)}
                              type="button"
                            >
                              {t('settings.actions.confirmKeep')}
                            </button>
                          </>
                        ) : (
                          /* Asked first, because this is a click that may destroy
                             the only record of a password. The file is backed up
                             beside itself either way. */
                          <button
                            className="quiet"
                            onClick={() => setConfirming(selected)}
                            type="button"
                          >
                            {t('settings.actions.remove')}
                          </button>
                        ))}
                    </>
                  }
                  bands={bands}
                  copy={
                    selected === NEW_CHARACTER && characters.length > 0
                      ? { from: copyFrom, choices: characters, onChoose: copyCharacter }
                      : null
                  }
                  creating={selected === NEW_CHARACTER}
                  figures={figures}
                  firstFieldRef={firstFieldRef}
                  form={form}
                  inheritedLoops={inheritedLoops}
                  maxima={maxima}
                  onManageRealms={goToServers}
                  onSubmit={(event) => void submitCharacter(event)}
                  onToggleLoop={toggleLoop}
                  palette={palette}
                  patch={patch}
                  realm={realm}
                  section={section}
                  servers={servers}
                  shelf={shelf}
                  shown={characters.find((entry) => entry.id === selected)}
                />
              )}
            </>
          ) : (
            <>
              {/*
                A realm has no sections -- its form is short enough to read
                whole -- so the rail here is the picker alone. It is still the
                rail rather than the old list, because navigation that changed
                shape from page to page would be two screens.
              */}
              <SettingsNav
                onSection={() => undefined}
                picker={{
                  addId: NEW_SERVER,
                  addLabel: t('settings.realms.new'),
                  choices: servers.map((server) => ({
                    id: server.name,
                    name: server.name,
                    detail: `${server.host}:${server.port}`
                  })),
                  chosen: serverPick,
                  label: t('settings.nav.realm'),
                  onChoose: (name: string) => chooseServer(name)
                }}
                section=""
                sections={[]}
              />

              {serverForm === null ? (
                <div className="settings-form empty">{t('settings.realms.empty')}</div>
              ) : (
                <ServerForm
                  actions={
                    <>
                      {serverPick === NEW_SERVER ? (
                        <button className="primary" type="submit">
                          {t('settings.realms.submit')}
                        </button>
                      ) : (
                        <FormActions
                          can={active.can}
                          error={active.save.error}
                          onRedo={active.redo}
                          onUndo={active.undo}
                          state={active.save.state}
                        />
                      )}
                      {serverPick !== NEW_SERVER &&
                        (confirming === serverPick ? (
                          <>
                            <span className="hint">{t('settings.realms.confirmRemove')}</span>
                            <button
                              className="danger"
                              onClick={() => void removeServer()}
                              type="button"
                            >
                              {t('settings.actions.confirmYes')}
                            </button>
                            <button
                              className="quiet"
                              onClick={() => setConfirming(null)}
                              type="button"
                            >
                              {t('settings.actions.confirmKeep')}
                            </button>
                          </>
                        ) : (
                          <button
                            className="quiet"
                            onClick={() => setConfirming(serverPick)}
                            type="button"
                          >
                            {t('settings.actions.remove')}
                          </button>
                        ))}
                    </>
                  }
                  chooseRealm={chooseRealm}
                  draft={serverForm}
                  firstFieldRef={firstFieldRef}
                  onChange={setServerForm}
                  onSubmit={(event) => void submitServer(event)}
                  onToggleLoop={toggleServerLoop}
                  shelf={shelf}
                />
              )}
            </>
          )}
        </div>

        <footer className="settings-foot">
          {problem !== null && <span className="settings-problem">{problem}</span>}
          {problem === null && saved !== null && <span className="settings-saved">{saved}</span>}
          {/* Everything this screen does not cover is one click away, and
              saying so is what keeps the screen from having to grow into a
              YAML editor. */}
          <span className="settings-paths">
            <button className="quiet" onClick={revealConfig} onMouseDown={keepFocus} type="button">
              {t('settings.footer.openConfig')}
            </button>
            <button
              className="quiet"
              onClick={revealProfiles}
              onMouseDown={keepFocus}
              type="button"
            >
              {t('settings.footer.openProfiles')}
            </button>
          </span>
        </footer>

        {/*
          The corner, and only the corner. The panel opens at the top left and
          the two things anybody wants of it are *smaller* and *taller so the
          form fits*; eight handles would be seven more edges to hit by
          accident on a surface whose whole body is controls.
        */}
        {!required && (
          <button
            aria-label={t('settings.dialog.resizeAria')}
            className="settings-grip"
            onDoubleClick={panel.reset}
            onPointerDown={panel.resize}
            type="button"
          />
        )}
      </div>
    </div>
  );
}

/**
 * A press on a control inside the heading is a click, never the start of a
 * drag.
 *
 * Stopping it here rather than having the heading test what was underneath:
 * the row is the handle, and a control that does not want to be dragged says
 * so itself — which is one line per control and no list to keep in step.
 */
function stopDrag(event: React.PointerEvent): void {
  event.stopPropagation();
}
