import fs from 'node:fs';
import path from 'node:path';
import { isMap, isSeq, parse, Scalar } from 'yaml';

import { editYaml, removeYaml, type EditResult } from './YamlFile';
import type { RemoteGrant, RemoteName } from '../../shared/remotes';
import { LoopStore, readLoops } from './LoopStore';
import { ServerStore } from './ServerStore';
import { directoryNames } from './dirs';
import {
  asServer,
  AUTOMATION_SWITCHES,
  DEFAULT_CONFIG,
  mergeServers,
  normalizeConfig,
  type AutomationSwitch,
  type RetreatConfig,
  type SupplyItem
} from '../../shared/config';
import { fileSlug } from '../../shared/files';
import { loopFileName, type Loop, type LoopScope, type ScopedLoop } from '../../shared/loops';
import type { Home } from '../app/home';
import { t } from '../app/i18n';
import { PROFILE_ACCENTS, resolveProfile, type ProfileAccent } from '../../shared/profiles';
import { isThemePreference, type ThemePreference } from '../../shared/themes';
import type { GlobalDraft, ProfileDraft, ServerDraft } from '../../shared/drafts';
import type { ProfileEditable, SettingsSnapshot, SpellOption } from '../../shared/ipc';
import type { CureGates } from '../../shared/spellcraft';
import type { ConnectionTarget } from '../../shared/types';
import { errorMessage, isRecord } from '../../shared/values';

/**
 * Writing what a settings screen collects into the files that own it.
 *
 * Characters, servers and loops each live in their own directory under the
 * client's home (see `app/home.ts`), and this writes into that tree. The shape
 * is not this module's choice — it is the file format — and keeping to it is
 * what lets somebody edit any of it by hand afterwards without the client
 * fighting them.
 *
 * Three rules it exists to keep:
 *
 * 1. **A draft patches a file; it never replaces one.** A profile is a sparse
 *    overlay and may carry `automation:` or `ui:` blocks this screen knows
 *    nothing about. Writing the fields a form happens to have would delete
 *    them, and the deletion would look like the save working.
 * 2. **Nothing is written that the client could not then load.** Every save is
 *    verified by running the result back through the same resolver the client
 *    uses. A profile that would be reported and skipped is refused at the point
 *    somebody could still fix it.
 * 3. **A password is never in a message.** These functions return errors that
 *    reach the terminal and the notice channel; not one of them interpolates a
 *    value from the draft.
 */
export interface SettingsEditorOptions {
  /** Every path the client owns. See `app/home.ts`. */
  home: Home;
  /**
   * What the spell pickers can offer, injected from `index.ts` because it is
   * the realm layer's to answer: the character's own persisted spellbook and
   * the cure gates computed over it, and the shipped realm's castable spells
   * for the Global page. Optional so a test constructing `{ home }` gets the
   * honest absences — no book read, no gates, an empty realm list.
   */
  spells?: {
    forProfile(
      id: string,
      target: ConnectionTarget
    ): {
      spellbook: SpellOption[] | null;
      cureGates: CureGates | null;
    };
    realm(): SpellOption[];
  };
}

/**
 * Whether a combat draft differs from the defaults at all.
 *
 * Compared against `DEFAULT_CONFIG` rather than against a copy written out
 * here, so a default that changes cannot leave this asserting the old one — the
 * same rule the options template follows: defaults live in exactly one place.
 */
/*
 * Compared field by field against `DEFAULT_CONFIG` rather than against a copy
 * written out here, so a default that changes cannot leave this asserting the
 * old one — the same rule the options template follows: defaults live in
 * exactly one place. Structural rather than one function per block, because
 * there are four of them now and four copies of the same comparison is four
 * places for a new field to be forgotten.
 */
function statesSomething(draft: unknown, defaults: Record<string, unknown>): boolean {
  const block = (draft ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(defaults)) {
    const mine = block[key];
    if (Array.isArray(value)) {
      if (!Array.isArray(mine)) return true;
      if (mine.length !== value.length) return true;
      if (mine.some((entry, index) => entry !== value[index])) return true;
      continue;
    }
    if (mine !== value) return true;
  }
  return false;
}

export class SettingsEditor {
  private readonly home: Home;
  private readonly spells: SettingsEditorOptions['spells'];

  constructor(options: SettingsEditorOptions) {
    this.home = options.home;
    this.spells = options.spells;
  }

  private profilePath(id: string): string {
    return this.home.profile(id).file;
  }

  /**
   * The servers and loops on disk, read fresh.
   *
   * Constructed per call rather than held: this class is built per IPC
   * operation precisely so that what it writes is checked against what is on
   * disk *now*, and a store captured when the screen opened would be a
   * snapshot of whatever was there then.
   */
  private tree(): { servers: ServerStore; loops: LoopStore } {
    return { servers: new ServerStore(this.home), loops: new LoopStore(this.home) };
  }

  /**
   * The options file as written, with the servers on disk folded in.
   *
   * Exactly what `ConfigStore` composes for the running client, and it has to
   * be: this is what a profile is verified against, and a base that knew only
   * the file's own `servers:` would refuse every character whose server is a
   * directory — which, after the migration, is all of them.
   */
  private baseSource(): unknown {
    const file = this.readOptions();
    const stated = normalizeConfig(file).servers;
    const found = new ServerStore(this.home).servers;
    if (found.length === 0) return file;
    return {
      ...(isRecord(file) ? file : {}),
      servers: mergeServers(stated, found)
    };
  }

  /** The options file alone, for an edit that has to leave the rest of it be. */
  private readOptions(): unknown {
    try {
      return parse(fs.readFileSync(this.home.options, 'utf8')) ?? {};
    } catch {
      // A missing or unreadable options file is not a reason to refuse a
      // character: `resolveProfile` treats an empty base as "no saved servers",
      // which only rules out a profile referring to one by name — and that
      // refusal is correct.
      return {};
    }
  }

  /**
   * Creates or updates one character.
   *
   * The whole draft is applied, but only the keys the draft describes: a file
   * that already carries an `automation:` block keeps it, because a character
   * whose rules vanished when its colour was changed is worse than no editor.
   */
  saveProfile(id: string, draft: ProfileDraft): EditResult {
    const file = this.profilePath(id);
    const base = this.baseSource();
    /*
     * A character takes a **copy** of the Global defaults when it is made.
     *
     * The form is seeded from them (`emptyForm`), and on creation every block
     * below is written whole rather than only when it differs from the shipped
     * default — so from that moment the character states what it does and a
     * later change to Global changes what the *next* character starts with,
     * not this one. That is the whole of "Global is just defaults".
     */
    const creating = !fs.existsSync(file);

    const written = editYaml(file, {
      mutate: (document) => {
        document.setIn(['name'], draft.name.length > 0 ? draft.name : id);
        document.setIn(['accent'], draft.accent);
        document.setIn(['autoConnect'], draft.autoConnect);
        document.setIn(['autoReconnect'], draft.autoReconnect);
        // A theme is `ui.theme`, the overlay every other setting uses; blank
        // means "follow the options file", so the key is removed rather than
        // written empty, and an emptied `ui` map goes with it.
        // Blank clears only a theme the form could have shown: a value the
        // screen does not recognise was never on the form, and a draft
        // patches what it knows about and nothing else.
        if (draft.theme !== '') document.setIn(['ui', 'theme'], draft.theme);
        else if (isThemePreference(document.getIn(['ui', 'theme']))) {
          document.deleteIn(['ui', 'theme']);
          const ui = document.get('ui');
          if (
            ui &&
            typeof ui === 'object' &&
            'items' in ui &&
            (ui as { items: unknown[] }).items.length === 0
          ) {
            document.deleteIn(['ui']);
          }
        }

        if (draft.server.kind === 'saved') {
          // A reference, so renaming the host in one place moves every
          // character that plays there.
          document.setIn(['server'], draft.server.name);
        } else {
          // Replaced wholesale rather than patched key by key: switching from a
          // saved server to an inline one must not leave the old name behind
          // as a sibling of the new host.
          document.setIn(['server'], {
            host: draft.server.host,
            port: draft.server.port,
            encoding: draft.server.encoding
          });
        }

        /*
         * Credentials go inline on the character, always. Two characters on
         * one BBS account simply state the same username in two files — there
         * is no shared store to keep them in step, and a password that drifts
         * between them is theirs to notice, not the client's to prevent.
         */
        if (draft.username.length > 0) {
          /*
           * A blank password field means "I did not touch this", not "there
           * is no password". The screen is never told the current one — a
           * password that has crossed to a renderer can reach a devtools
           * snapshot or a screenshot — so it cannot echo it back, and
           * treating blank as empty would silently wipe the account's
           * credentials every time somebody changed its colour.
           */
          const existing = document.getIn(['account', 'password']);
          document.setIn(['account'], {
            username: draft.username,
            password: draft.changePassword
              ? draft.password
              : typeof existing === 'string'
                ? existing
                : ''
          });
        } else if (document.hasIn(['account'])) {
          // No username is a character that has not been given an account
          // yet, which is a legitimate state: it connects and waits at the
          // prompt. An empty `account:` block would resolve to no account and
          // read as a mistake.
          document.deleteIn(['account']);
        }

        /*
         * This character's own menu script, written only when it has one.
         *
         * Absent means "use the server's", which is the ordinary case: the
         * script belongs to the BBS. A `login:` block left behind empty would
         * mean the opposite — a character that answers *no* menus — and would
         * be noise in a file people read besides.
         */
        if (draft.login.length > 0) {
          document.setIn(
            ['login', 'steps'],
            draft.login.map((step) => ({ when: step.when, send: step.send }))
          );
        } else if (document.hasIn(['login'])) {
          document.deleteIn(['login']);
        }

        /*
         * The two escapes, written whenever the character has anything to say
         * about them — which now includes saying *no*.
         *
         * They used to be deleted when switched off, on the reading that a
         * disabled block carries nothing but a threshold nobody chose. That is
         * true of a fresh character and false of one whose defaults turned
         * the retreat on: deleting the key put the character straight back on
         * the inherited `enabled: true`, so the switch could not be switched
         * off.
         * Stating it is the only way to mean it.
         */
        if (
          creating ||
          draft.retreat.enabled ||
          document.hasIn(['automation', 'safety', 'retreat'])
        ) {
          document.setIn(['automation', 'safety', 'retreat'], {
            enabled: draft.retreat.enabled,
            belowHealth: draft.retreat.belowHealth,
            whenOutnumbered: draft.retreat.whenOutnumbered,
            strategy: draft.retreat.strategy,
            safeHavenRoom: draft.retreat.safeHavenRoom
          });
        }

        if (
          creating ||
          draft.hangUp.enabled ||
          document.hasIn(['automation', 'safety', 'hangUp'])
        ) {
          document.setIn(['automation', 'safety', 'hangUp'], {
            enabled: draft.hangUp.enabled,
            belowHealth: draft.hangUp.belowHealth,
            onlyWhenClean: draft.hangUp.onlyWhenClean,
            onPlayerInRoom: draft.hangUp.onPlayerInRoom
          });
        }

        if (
          creating ||
          draft.pvp.notifyGang ||
          draft.pvp.action !== 'none' ||
          document.hasIn(['automation', 'safety', 'pvp'])
        ) {
          document.setIn(['automation', 'safety', 'pvp'], {
            notifyGang: draft.pvp.notifyGang,
            action: draft.pvp.action
          });
        }

        /*
         * The blocks a character owns outright, once it has been made here.
         *
         * Three reasons a block is written, and the order matters:
         *
         * - **It is being created.** The copy of the Global defaults is taken
         *   now, whole, whether or not it happens to equal the shipped one —
         *   otherwise the copy would be indistinguishable from inheritance and
         *   a later change to Global would reach back into this character.
         * - **The file already states it.** Once stated, kept: silently
         *   deleting a block because its values drifted back to the defaults
         *   would put the character back on inheritance without saying so.
         * - **It differs from the shipped default.** Which is what a file
         *   somebody wrote by hand, and has never opened this screen for, is
         *   judged by.
         *
         * The lists are the reason this cannot simply follow the switch:
         * `combat` carries which monsters to leave alone, which to go for
         * first and what the character's opener is, and dropping those the
         * moment somebody unticks a box loses work they typed with no way to
         * know until they turn it back on.
         */
        for (const [at, block, defaults] of [
          [['automation', 'combat'], draft.combat, DEFAULT_CONFIG.automation.combat],
          [['automation', 'party'], draft.party, DEFAULT_CONFIG.automation.party],
          [['automation', 'health'], draft.health, DEFAULT_CONFIG.automation.health],
          [['automation', 'movement'], draft.movement, DEFAULT_CONFIG.automation.movement],
          [['automation', 'spells'], draft.spells, DEFAULT_CONFIG.automation.spells],
          [['automation', 'remotes'], draft.remotes, DEFAULT_CONFIG.automation.remotes],
          // Not under `automation:`, because it is not something the client
          // *does* — it is what this player wants to hear about this character.
          [['ui', 'alerts'], draft.alerts, DEFAULT_CONFIG.ui.alerts]
        ] as const) {
          if (
            creating ||
            document.hasIn(at) ||
            statesSomething(block, defaults as unknown as Record<string, unknown>)
          ) {
            document.setIn(at, { ...block });
          }
        }
      },
      verify: (value) => {
        const result = resolveProfile(id, value, base);
        if (result.error !== undefined) return result.error;
        return null;
      }
    });

    /*
     * The loops this character alone may walk, as files beside its own.
     *
     * Not a key in the file, because a list inside a file cannot say *scope* —
     * which is the whole reason loops moved out (see `LoopStore`). The draft
     * carries only what this character owns, so the global and server ones are
     * neither written here nor at risk of being written into it.
     *
     * After the file, and only if the file was written: a character whose
     * profile was refused must not end up with loops it cannot walk.
     */
    if (!written.ok) return written;
    return writeLoops(this.home.profile(id).loops, draft.loops);
  }

  /**
   * One player's whole grant on one character — what they may ask for, and what
   * they may never ask for whatever the gang says.
   *
   * Narrow on purpose, and narrow in the dimension that matters: a flyout holds
   * one name and knows nothing about the rest of that character's settings, so
   * it must not send a whole `ProfileDraft` — a card saving a stale copy of a
   * form it never showed is how a setting changed in Settings gets silently
   * reverted by a click somewhere else. It sends the whole grant for that *one*
   * name, which is exactly what it shows.
   *
   * **The whole grant and not one remote**, because *Allow all* is one press and
   * would otherwise be twenty rewrites of the same file racing each other.
   *
   * **A remote goes on exactly one list.** A name on both would be a
   * contradiction the reader would have to know the precedence rule to resolve,
   * and a permission screen that needs a rule explained is one people get
   * wrong; `deny` wins, so a remote in both arrives here already resolved by
   * dropping it from `allow`.
   *
   * **An emptied grant is removed, not left as two empty lists.** A `players:`
   * map that accumulated a key per person anybody ever clicked would grow
   * without bound and would read, in the user's own file, as a list of people
   * with permissions — when what it holds is people with none.
   *
   * Comments survive, like every write here: `editYaml` uses `parseDocument`,
   * and the file being edited is full of the user's own notes.
   */
  setRemoteGrant(id: string, name: string, grant: RemoteGrant): EditResult {
    const who = name.trim();
    if (who.length === 0) return { ok: false, error: t('errors.settings.remoteNameRequired') };
    const file = this.profilePath(id);
    if (!fs.existsSync(file)) {
      return { ok: false, error: t('errors.settings.characterNotFound', { id }) };
    }

    // Lower-cased, once, the way `normalizeConfig` and `PlayerRegistry` key a
    // name: `Soul` clicked from a `who` listing and `soul` typed in a telepath
    // are one person, and two keys would be one grant that works and one that
    // silently does not.
    const key = who.toLowerCase();
    const deny = [...new Set(grant.deny)];
    const allow = [...new Set(grant.allow)].filter((remote) => !deny.includes(remote));

    return editYaml(file, {
      mutate: (document) => {
        if (allow.length === 0 && deny.length === 0) {
          document.deleteIn(['automation', 'remotes', 'players', key]);
          /*
           * And the map itself once the last name comes off it, so a file that
           * has been cleared reads as one with no per-player permissions rather
           * than one with an empty `players: {}` somebody has to interpret.
           */
          const players = document.getIn(['automation', 'remotes', 'players'], true);
          if (isMap(players) && players.items.length === 0) {
            document.deleteIn(['automation', 'remotes', 'players']);
          }
          return;
        }
        document.setIn(
          ['automation', 'remotes', 'players', key],
          document.createNode({ allow, deny })
        );
        /*
         * Block style, explicitly, because the map this writes into is usually
         * the empty `players: {}` a profile save wrote — and `{}` is a *flow*
         * collection, which every node set inside it then inherits. The result
         * was one line of `players: { soul: { allow: [ health ], deny: [] } }`
         * in a file where every other list is a block. It is the user's file
         * and it is read by people.
         */
        const players = document.getIn(['automation', 'remotes', 'players'], true);
        if (isMap(players)) players.flow = false;
      }
    });
  }

  /**
   * What anybody in this character's gang may ask for.
   *
   * The Gang card's own write, and the same narrowness applies: the card shows
   * the whole gang list and nothing else about the character, so the whole gang
   * list is what it sends.
   */
  setGangRemotes(id: string, remotes: readonly RemoteName[]): EditResult {
    const file = this.profilePath(id);
    if (!fs.existsSync(file)) {
      return { ok: false, error: t('errors.settings.characterNotFound', { id }) };
    }
    const gang = [...new Set(remotes)];
    return editYaml(file, {
      mutate: (document) => document.setIn(['automation', 'remotes', 'gang'], gang)
    });
  }

  /**
   * Whether this character answers `@` commands on the gangpath.
   *
   * On the Gang card as well as in Settings, because the card is where the
   * consequence is visible — a gang list that grants `@exp` and a gangpath
   * switch that is off is a grant nobody in the gang can use from the channel
   * they would naturally use it on. A command nobody can find does not exist,
   * and neither does one that silently cannot fire.
   */
  setRemoteGangpath(id: string, on: boolean): EditResult {
    const file = this.profilePath(id);
    if (!fs.existsSync(file)) {
      return { ok: false, error: t('errors.settings.characterNotFound', { id }) };
    }
    return editYaml(file, {
      mutate: (document) => document.setIn(['automation', 'remotes', 'gangpath'], on)
    });
  }

  /**
   * This character's whole supplies list — `automation.supplies.items`.
   *
   * The Self card's and the item panel's write, and the gang list's shape for
   * the gang list's reason: the surface shows the whole list, and one write
   * per change cannot race a second. Written as a block sequence with
   * flow-style rows, so a file somebody reads by hand says one item per line.
   * Not a `saveProfile`, for the reason `setRemoteGrant` is not.
   */
  setSupplies(id: string, items: readonly SupplyItem[]): EditResult {
    const file = this.profilePath(id);
    if (!fs.existsSync(file)) {
      return { ok: false, error: t('errors.settings.characterNotFound', { id }) };
    }
    const rows = items.map((item) => ({
      name: item.name,
      min: item.min,
      max: item.max,
      shop: item.shop,
      ...(item.at === null ? {} : { at: { map: item.at.map, room: item.at.room } })
    }));
    return editYaml(file, {
      mutate: (document) => {
        document.setIn(['automation', 'supplies', 'items'], rows);
        const list = document.getIn(['automation', 'supplies', 'items'], true);
        if (isSeq(list)) {
          list.flow = false;
          for (const row of list.items) if (isMap(row)) row.flow = true;
        }
      }
    });
  }

  /**
   * Flips one `automation:` boolean in a character's own file.
   *
   * The toolbar's write, and the narrowest one here: the control shows one
   * boolean and nothing else about the character, so one boolean is what it
   * sends. Not a `saveProfile` for the reason `setRemoteGrant` is not one —
   * that form is populated from the *resolved* configuration, so saving from a
   * control that can see a single switch would write every inherited global
   * setting into the character's own file and turn an overlay into a copy.
   *
   * The path comes from `AUTOMATION_SWITCHES` and the name is parsed before it
   * gets here, so nothing off the wire chooses where this writes. Comments
   * survive, like every write here.
   */
  setAutomationSwitch(id: string, name: AutomationSwitch, on: boolean): EditResult {
    const file = this.profilePath(id);
    if (!fs.existsSync(file)) {
      return { ok: false, error: t('errors.settings.characterNotFound', { id }) };
    }
    return editYaml(file, {
      mutate: (document) => document.setIn(['automation', ...AUTOMATION_SWITCHES[name]], on)
    });
  }

  /**
   * Puts **one** loop into one scope's directory, leaving the rest alone.
   *
   * The Loops modal picks a loop out of a shelf of four hundred and says where
   * it should live, which is a different act from the settings screen's, and it
   * needs a different writer. `writeLoops` reconciles a whole *set*: it deletes
   * every file whose loop is not in the list it was handed, which is right for
   * a form that shows the complete list and wrong for a modal that has only
   * ever seen one — sending a single loop through it would take every other
   * loop in that scope with it, silently.
   *
   * Idempotent by **name**, which is how a loop is addressed everywhere in this
   * client: choosing one twice rewrites its file rather than filing a second
   * copy under a slug with a number on the end. That matters here more than in
   * the form, because the modal is deliberately easy to open and a loop already
   * held is exactly the row somebody clicks again to check.
   *
   * The scope is the directory, as always — nothing inside the file says where
   * it is, so this is the only thing that decides.
   */
  addLoop(scope: LoopScope, owner: string | null, loop: Loop): EditResult {
    const dir = this.loopsDirectory(scope, owner);
    if (dir === null) {
      return { ok: false, error: t('errors.settings.loopScopeUnknown') };
    }

    /*
     * Its existing file when it has one, so a name kept is a file kept and the
     * comments somebody wrote in it survive being chosen again.
     */
    const existing = readLoopFiles(dir);
    const found = existing.find((entry) => entry.name.toLowerCase() === loop.name.toLowerCase());
    const slug = found?.slug ?? loopFileName(loop.name, new Set(existing.map((e) => e.slug)));

    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }

    return editYaml(path.join(dir, `${slug}.yaml`), {
      // Key by key, like every other edit to a file the user owns.
      mutate: (document) => {
        const node = loopNode(loop);
        for (const [key, value] of Object.entries(node)) document.setIn([key], value);
        if (node['bounce'] === undefined && document.hasIn(['bounce'])) {
          document.deleteIn(['bounce']);
        }
      }
    });
  }

  /**
   * Where a scope's loops live, or null when the owner it needs is missing.
   *
   * `global` owns itself; the other two are named by a directory id that has to
   * exist. A null here is refused out loud rather than defaulted to global — a
   * loop quietly filed where it was not asked for is one every character on the
   * client then walks.
   */
  private loopsDirectory(scope: LoopScope, owner: string | null): string | null {
    if (scope === 'global') return this.home.globalLoops;
    if (owner === null || owner.length === 0) return null;
    if (scope === 'profile') {
      return fs.existsSync(this.profilePath(owner)) ? this.home.profile(owner).loops : null;
    }
    const id = new ServerStore(this.home).idFor(owner);
    return id === undefined ? null : this.home.server(id).loops;
  }

  /**
   * Removes a character's file.
   *
   * Keeps a backup, because this is a click and the file may hold the only
   * record of a password. It does **not** touch the session: a file
   * disappearing is an edit, and an edit must not cut a socket out from under
   * somebody standing in a dangerous room (docs/profiles.md). `ProfileStore`
   * reports the removal and the session stays until it is idle.
   */
  deleteProfile(id: string): EditResult {
    return removeYaml(this.profilePath(id));
  }

  /**
   * Adds or updates a server: its own file, in its own directory.
   *
   * Matched on the **directory**, not on the name, which is what makes renaming
   * one a rename rather than a second server appearing beside the first. The
   * id is generated from the name the first time and never changes after: the
   * loops in `servers/<id>/loops` belong to the place, and a rename must not
   * strand them under a directory nothing looks in.
   */
  saveServer(previousName: string | null, draft: ServerDraft): EditResult {
    const { servers } = this.tree();
    const existing = previousName !== null ? servers.idFor(previousName) : undefined;

    /*
     * A name is how a character addresses a server (`server: GreaterMUD
     * (local)` in its own file), so two servers may not share one — the
     * reference would be ambiguous and `mergeServers` would silently keep only
     * the later. Refused here, where somebody can still change it.
     */
    const clash = servers.all.find(
      (entry) =>
        entry.server.name.toLowerCase() === draft.name.toLowerCase() && entry.id !== existing
    );
    if (clash) {
      return { ok: false, error: t('errors.settings.duplicateRealmName', { name: draft.name }) };
    }

    const id = existing ?? fileSlug(draft.name, new Set(servers.all.map((entry) => entry.id)));
    const scope = this.home.server(id);

    const result = editYaml(scope.file, {
      mutate: (document) => {
        document.setIn(['name'], draft.name);
        document.setIn(['host'], draft.host);
        document.setIn(['port'], draft.port);
        document.setIn(['encoding'], draft.encoding);
        /*
         * The menu script, written only when there is one — and *removed* when
         * the last row is deleted, unlike the fields above, which always have a
         * value. A server with no menus is every MUD reached directly rather
         * than through a BBS front end, and an empty `login: []` left behind
         * reads as a script somebody meant to fill in.
         */
        if (draft.login.length > 0) {
          document.setIn(
            ['login'],
            draft.login.map((step) => ({ when: step.when, send: step.send }))
          );
        } else if (document.hasIn(['login'])) {
          document.deleteIn(['login']);
        }

        /*
         * The realm's own map, written only when it names one — an empty
         * `database` is the world the client ships, which is what a realm with
         * no key already gets, and a key restating a default is noise in a file
         * people read. Same rule the menu script above follows.
         */
        if (draft.database.length > 0) document.setIn(['database'], draft.database);
        else if (document.hasIn(['database'])) document.deleteIn(['database']);
      },
      verify: (value) => {
        const server = asServer(value, id);
        if (!server) return t('errors.settings.realmSaveVerifyFailed');
        if (server.host !== draft.host || server.port !== draft.port) {
          return t('errors.settings.realmSaveMismatch');
        }
        return null;
      }
    });

    if (!result.ok) return result;
    /*
     * An entry still written into the options file becomes its own directory
     * by being edited.
     *
     * Servers moved out of that file and `migrateHome` brings the whole block
     * across, but a list somebody typed back in by hand is still read and still
     * offered — so it is still on this screen, and a screen that offered an
     * entry it could not then edit or delete would be a dead control. Editing
     * one writes the directory above and drops the entry here, which is the
     * same move the migration makes, made one server at a time.
     */
    if (existing === undefined) this.dropStatedServer(previousName ?? draft.name);
    return writeLoops(scope.loops, draft.loops);
  }

  /**
   * Takes a server out of the `servers:` list in the options file.
   *
   * Best effort and silent: it is a leftover from before servers were files,
   * the directory that replaces it has already been written, and a failure
   * here leaves a duplicate name rather than losing anything — `mergeServers`
   * keeps the file on disk, which is the one somebody just edited.
   */
  private dropStatedServer(name: string): void {
    const wanted = name.trim().toLowerCase();
    editYaml(this.home.options, {
      mutate: (document) => {
        const entries = (parse(String(document))?.['servers'] ?? []) as { name?: string }[];
        if (!Array.isArray(entries)) return;
        const at = entries.findIndex((entry) => (entry?.name ?? '').toLowerCase() === wanted);
        if (at !== -1) document.deleteIn(['servers', at]);
      }
    });
  }

  /**
   * Removes a server.
   *
   * Refused while a character still refers to it by name. Removing it would
   * leave that character unresolvable — reported and skipped on the next read,
   * which is the correct behaviour for a file somebody broke by hand and a
   * terrible one for a button somebody pressed.
   *
   * **The loops stay.** They are a fact about the realm rather than about the
   * entry that named it, they may be the only copy of an evening's work, and
   * deleting them is not what the button says. The directory goes only when
   * there is nothing left in it.
   */
  deleteServer(name: string): EditResult {
    const users = this.charactersUsing(name);
    if (users.length > 0) {
      return {
        ok: false,
        error: t('errors.settings.realmInUse', {
          name,
          users: users.join(' and '),
          playsOrPlay: users.length === 1 ? 'plays' : 'play'
        })
      };
    }

    const { servers } = this.tree();
    const id = servers.idFor(name);
    if (id === undefined) {
      // Only ever written into the options file. Removing it there is the
      // whole job — see `dropStatedServer`.
      const stated = normalizeConfig(this.readOptions()).servers;
      if (!stated.some((server) => server.name.toLowerCase() === name.toLowerCase())) {
        return { ok: false, error: t('errors.settings.realmNotFound', { name }) };
      }
      this.dropStatedServer(name);
      return { ok: true };
    }

    const scope = this.home.server(id);
    const removed = removeYaml(scope.file);
    if (!removed.ok) return removed;

    try {
      // Only when it is genuinely empty — the backup `server.yaml.bak` counts,
      // so in practice this runs when somebody has cleaned up by hand.
      fs.rmdirSync(scope.dir);
    } catch {
      // Loops, or a backup, or something the user put there. Left alone.
    }
    return { ok: true };
  }

  /**
   * The options file, as a form holds it.
   *
   * Read through `normalizeConfig`, so every field has the shipped default
   * behind it and the screen shows what the client would actually do rather
   * than what this particular file happens to mention. That is the opposite
   * of the rule a *character* is read under — a profile is a sparse overlay
   * and a form populated from the resolved config would write every inherited
   * setting into its file — and it is right here for the same reason it is
   * wrong there: this **is** the file everything is inherited from.
   *
   * **No password crosses the boundary.** The screen is told whether one is on
   * file and nothing more, exactly as for a character.
   */
  globalDraft(): GlobalDraft {
    const config = normalizeConfig(this.readOptions());
    const loops = new LoopStore(this.home).globalLoops;

    return {
      connection: {
        host: config.connection.host,
        port: config.connection.port,
        encoding: config.connection.encoding,
        login: { steps: config.connection.login.steps.map((step) => ({ ...step })) }
      },
      terminal: {
        // One field, comma-separated: a stack is a list and a list of text
        // boxes for it is four controls for one answer. `resolveTerminalFonts`
        // appends the fallback ladder regardless, so what is here is the
        // *preference* rather than the whole stack.
        fontFamily: config.terminal.font.family.join(', '),
        fontSize: config.terminal.font.size,
        scrollback: config.terminal.scrollback,
        cursorBlink: config.terminal.cursorBlink,
        cursorStyle: config.terminal.cursorStyle
      },
      ui: {
        fontFamily: config.ui.font.family.join(', '),
        theme: config.ui.theme,
        density: config.ui.density,
        tabs: config.ui.tabs,
        showHud: config.ui.showHud,
        vitals: {
          hp: { ...config.ui.vitals.hp },
          mana: { ...config.ui.vitals.mana }
        },
        alerts: { minimum: config.ui.alerts.minimum, mute: [...config.ui.alerts.mute] }
      },
      logging: {
        enabled: config.logging.enabled,
        directory: config.logging.directory,
        capture: config.logging.capture,
        fights: config.logging.fights,
        conversations: config.logging.conversations,
        conversationDays: config.logging.conversationDays,
        maxBytes: config.logging.maxBytes
      },
      automation: {
        enabled: config.automation.enabled,
        onEnterRealm: [...config.automation.onEnterRealm],
        onPartyChange: config.automation.onPartyChange,
        idle: { ...config.automation.idle },
        pacing: { ...config.automation.pacing },
        walk: { ...config.automation.walk },
        hangUp: {
          enabled: config.automation.safety.hangUp.enabled,
          belowHealth: config.automation.safety.hangUp.belowHealth,
          onlyWhenClean: config.automation.safety.hangUp.onlyWhenClean,
          onPlayerInRoom: config.automation.safety.hangUp.onPlayerInRoom
        },
        retreat: retreatOf(config.automation.safety.retreat),
        pvp: { ...config.automation.safety.pvp },
        combat: { ...config.automation.combat },
        party: { ...config.automation.party },
        health: { ...config.automation.health },
        movement: { ...config.automation.movement },
        spells: { ...config.automation.spells },
        loot: { ...config.automation.loot, items: [...config.automation.loot.items] },
        drop: { ...config.automation.drop, items: [...config.automation.drop.items] },
        search: { ...config.automation.search },
        banking: { ...config.automation.banking },
        remotes: { ...config.automation.remotes },
        talk: { ...config.automation.talk }
      },
      loops
    };
  }

  /**
   * Writes the options file, and the loops everybody walks beside it.
   *
   * **Set key by key, never replaced.** This file is the annotated template
   * the player has been editing since first run: it explains every setting
   * where it sits, and it is the documentation as much as the configuration.
   * A save that rebuilt it from the values on a form would take every one of
   * those comments with it — the same rule a character's file is edited under,
   * and it matters more here, because there is only one of these.
   *
   * Unlike a character, **every key is written**, not only the ones that differ
   * from the default. A character's file is an overlay and a key restating an
   * inherited value takes it out of the inheritance; this file *is* what is
   * inherited, so a value it does not state is a value the built-in default
   * decides — which is exactly what somebody moving a slider back to the
   * default means anyway.
   */
  saveGlobal(draft: GlobalDraft): EditResult {
    const written = editYaml(this.home.options, {
      mutate: (document) => {
        const set = (path: readonly string[], value: unknown): void => {
          document.setIn([...path], value);
        };

        set(['connection', 'host'], draft.connection.host);
        set(['connection', 'port'], draft.connection.port);
        set(['connection', 'encoding'], draft.connection.encoding);
        // No account and no autoconnect here: both belong to a character, and
        // `dropAnonymousConnection` has already taken any old ones out.
        set(
          ['connection', 'login', 'steps'],
          draft.connection.login.steps.map((step) => ({ when: step.when, send: step.send }))
        );

        set(['terminal', 'font', 'family'], splitNames(draft.terminal.fontFamily));
        set(['terminal', 'font', 'size'], draft.terminal.fontSize);
        set(['terminal', 'scrollback'], draft.terminal.scrollback);
        set(['terminal', 'cursorBlink'], draft.terminal.cursorBlink);
        set(['terminal', 'cursorStyle'], draft.terminal.cursorStyle);

        set(['ui', 'font', 'family'], splitNames(draft.ui.fontFamily));
        set(['ui', 'theme'], draft.ui.theme);
        set(['ui', 'density'], draft.ui.density);
        set(['ui', 'tabs'], draft.ui.tabs);
        set(['ui', 'showHud'], draft.ui.showHud);
        for (const vital of ['hp', 'mana'] as const) {
          set(['ui', 'vitals', vital, 'caution'], draft.ui.vitals[vital].caution);
          set(['ui', 'vitals', vital, 'critical'], draft.ui.vitals[vital].critical);
        }
        set(['ui', 'alerts', 'minimum'], draft.ui.alerts.minimum);
        set(['ui', 'alerts', 'mute'], [...draft.ui.alerts.mute]);

        set(['logging', 'enabled'], draft.logging.enabled);
        set(['logging', 'directory'], draft.logging.directory);
        set(['logging', 'capture'], draft.logging.capture);
        set(['logging', 'fights'], draft.logging.fights);
        set(['logging', 'conversations'], draft.logging.conversations);
        set(['logging', 'conversationDays'], draft.logging.conversationDays);
        set(['logging', 'maxBytes'], draft.logging.maxBytes);

        set(['automation', 'enabled'], draft.automation.enabled);
        set(['automation', 'onEnterRealm'], [...draft.automation.onEnterRealm]);
        set(['automation', 'onPartyChange'], draft.automation.onPartyChange);
        set(['automation', 'idle'], { ...draft.automation.idle });
        set(['automation', 'pacing'], { ...draft.automation.pacing });
        set(['automation', 'walk'], { ...draft.automation.walk });
        set(['automation', 'safety', 'hangUp'], { ...draft.automation.hangUp });
        set(['automation', 'safety', 'retreat'], { ...draft.automation.retreat });
        set(['automation', 'safety', 'pvp'], { ...draft.automation.pvp });
        set(['automation', 'combat'], { ...draft.automation.combat });
        set(['automation', 'party'], { ...draft.automation.party });
        set(['automation', 'health'], { ...draft.automation.health });
        set(['automation', 'movement'], { ...draft.automation.movement });
        set(['automation', 'spells'], { ...draft.automation.spells });
        set(['automation', 'loot'], { ...draft.automation.loot });
        set(['automation', 'drop'], { ...draft.automation.drop });
        set(['automation', 'banking'], { ...draft.automation.banking });
        set(['automation', 'remotes'], { ...draft.automation.remotes });
      },
      verify: (value) => {
        /*
         * Read back through the resolver the client actually uses. A file this
         * screen could write and the client could not then load would be worse
         * than a refused save: the watcher would pick it up, `normalizeConfig`
         * would fall back to defaults, and every character would quietly start
         * running under settings nobody chose.
         */
        const config = normalizeConfig(value);
        if (config.connection.host !== draft.connection.host) {
          return t('errors.settings.globalAddressMismatch');
        }
        return null;
      }
    });

    if (!written.ok) return written;
    return writeLoops(this.home.globalLoops, draft.loops);
  }

  /**
   * What a settings screen draws itself from.
   *
   * Read off disk each time rather than from the resolved profiles, and that
   * distinction is the same one `resolveProfile` documents: a resolved profile
   * carries the whole *merged* config, and a form populated from it would write
   * every inherited global setting back into the character's own file — turning
   * an overlay into a copy, which is the failure rule 1 exists to prevent.
   *
   * **A password never leaves this process.** The screen is told whether one is
   * on file and nothing more: a password in a renderer is one that can reach a
   * devtools snapshot, a crash report or a screenshot. A blank field means
   * "leave it alone", which is also the behaviour somebody expects.
   */
  snapshot(): SettingsSnapshot {
    // Servers folded in, so a character's `server:` reference resolves on this
    // screen exactly as it does for the running client. See `baseSource`.
    const source = this.baseSource();
    const tree = this.tree();
    const config = normalizeConfig(source);
    const characters: ProfileEditable[] = [];

    for (const id of this.characterIds()) {
      const file = this.home.profile(id).file;
      if (!fs.existsSync(file)) continue;
      let raw: unknown;
      try {
        raw = parse(fs.readFileSync(file, 'utf8'));
      } catch (error) {
        // One unreadable file never costs you the others, and the screen is
        // where somebody can actually do something about it.
        characters.push({
          ...blank(id),
          error: error instanceof Error ? error.message : t('errors.settings.profileUnreadable')
        });
        continue;
      }

      const record = isRecord(raw) ? raw : {};
      const account = record['account'];
      const login = isRecord(record['login']) ? record['login'] : {};
      const resolved = resolveProfile(id, record, source);
      const target: ConnectionTarget =
        resolved.error === undefined
          ? resolved.profile.target
          : { host: '', port: config.connection.port, encoding: config.connection.encoding };
      // The book is keyed by the address dialled, which is why it needs the
      // resolved target rather than only the id.
      const book = this.spells?.forProfile(id, target) ?? { spellbook: null, cureGates: null };
      // Read from the *resolved* config so a character inherits whatever the
      // options file says, which is the whole point of a profile being an
      // overlay: a form that showed only what the character's own file
      // mentioned would show `false` for a setting switched on globally.
      const effective = resolved.error === undefined ? resolved.profile.config : null;

      characters.push({
        id,
        name: typeof record['name'] === 'string' ? record['name'] : id,
        accent: accentOf(
          record['accent'],
          resolved.error === undefined ? resolved.profile.accent : 'cyan'
        ),
        autoConnect: record['autoConnect'] === true,
        // On unless the file says otherwise, so a character written before the
        // setting existed shows the tick it is actually running with.
        autoReconnect: record['autoReconnect'] !== false,
        theme: themeOf(record['ui']),
        serverName: typeof record['server'] === 'string' ? record['server'] : null,
        target,
        username:
          isRecord(account) && typeof account['username'] === 'string' ? account['username'] : '',
        hasPassword: isRecord(account)
          ? typeof account['password'] === 'string' && account['password'].length > 0
          : false,
        /*
         * The character's *own* script, from the file as written — not the
         * resolved one, which would fold in the server's and make every
         * character look as though it had overridden its BBS. The form's whole
         * point is the distinction: empty means "follow the server".
         */
        login: Array.isArray(login['steps'])
          ? login['steps']
              .filter(isRecord)
              .map((step) => ({ when: text(step['when']), send: text(step['send']) }))
              .filter((step) => step.when.length > 0)
          : [],
        /*
         * Falling back to the shipped defaults rather than to numbers written
         * out here. A default restated in a second place is a default that goes
         * stale the first time the first one changes, which is the rule the
         * options template already keeps: defaults live in exactly one place.
         */
        hangUp: effective?.automation.safety.hangUp ?? DEFAULT_CONFIG.automation.safety.hangUp,
        retreat: retreatOf(
          effective?.automation.safety.retreat ?? DEFAULT_CONFIG.automation.safety.retreat
        ),
        pvp: effective?.automation.safety.pvp ?? DEFAULT_CONFIG.automation.safety.pvp,
        combat: effective?.automation.combat ?? DEFAULT_CONFIG.automation.combat,
        party: effective?.automation.party ?? DEFAULT_CONFIG.automation.party,
        health: effective?.automation.health ?? DEFAULT_CONFIG.automation.health,
        movement: effective?.automation.movement ?? DEFAULT_CONFIG.automation.movement,
        remotes: effective?.automation.remotes ?? DEFAULT_CONFIG.automation.remotes,
        talk: effective?.automation.talk ?? DEFAULT_CONFIG.automation.talk,
        /*
         * This character's *own* loops, from its own directory — not the
         * resolved list, which folds in the server's and the global ones. The
         * form's whole point is that distinction: what is ticked here is what
         * this character adds, and what it inherits is shown beside it and
         * cannot be edited from a character's page.
         */
        loops: tree.loops.forProfile(id),
        inherited: inheritedLoops(
          tree,
          typeof record['server'] === 'string' ? record['server'] : null
        ),
        spells: effective?.automation.spells ?? DEFAULT_CONFIG.automation.spells,
        spellbook: book.spellbook,
        cureGates: book.cureGates,
        alerts: effective?.ui.alerts ?? DEFAULT_CONFIG.ui.alerts,
        ...(resolved.error !== undefined ? { error: resolved.error } : {})
      });
    }

    return {
      characters,
      servers: config.servers,
      /*
       * Loops by scope, so the screen can show each of the three where it is
       * edited: global on the client's own page, a server's on that server's,
       * a character's on its own. Keyed by the server's *name* rather than its
       * directory id, because a name is what a character refers to and what
       * the screen has in hand.
       */
      loops: {
        global: tree.loops.globalLoops,
        servers: Object.fromEntries(
          tree.servers.all.map((entry) => [entry.server.name, tree.loops.forServer(entry.id)])
        )
      },
      global: this.globalDraft(),
      realmSpells: this.spells?.realm() ?? [],
      home: this.home.root,
      configPath: this.home.options,
      profilesDir: this.home.profilesDir
    };
  }

  /** The character directories, sorted, so the list does not reshuffle. */
  private characterIds(): string[] {
    try {
      return directoryNames(this.home.profilesDir);
    } catch {
      return [];
    }
  }

  /** Names of characters whose file refers to this server by name. */
  charactersUsing(name: string): string[] {
    const wanted = name.toLowerCase();
    const found: string[] = [];
    for (const id of this.characterIds()) {
      try {
        const raw = parse(fs.readFileSync(this.home.profile(id).file, 'utf8'));
        const server = raw?.['server'];
        if (typeof server === 'string' && server.trim().toLowerCase() === wanted) found.push(id);
      } catch {
        // A file that does not parse is already reported by ProfileStore, and
        // it cannot be referring to anything.
      }
    }
    return found;
  }
}

/**
 * What a character walks without asking for it: its server's loops, then the
 * global ones.
 *
 * Most general last, so a screen reading it top to bottom says "everybody's,
 * then this realm's" — the order somebody thinks in when working out where a
 * loop they can see actually lives.
 */
function inheritedLoops(
  tree: { servers: ServerStore; loops: LoopStore },
  serverName: string | null
): ScopedLoop[] {
  const id = serverName === null ? undefined : tree.servers.idFor(serverName);
  const fromServer = id === undefined ? [] : tree.loops.forServer(id);
  return [
    ...fromServer.map((loop) => ({ loop, scope: 'server' as const, owner: serverName ?? '' })),
    ...tree.loops.globalLoops.map((loop) => ({ loop, scope: 'global' as const }))
  ];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * The retreat fields the form asks about, and not `cooldownMs`.
 *
 * That one is a floor on retrying rather than a decision about a character, so
 * it is not on the screen — and a payload carrying a field nothing renders is a
 * payload that invites somebody to render it. The way out and the haven are
 * decisions about a character, and are.
 */
function retreatOf(retreat: RetreatConfig): ProfileEditable['retreat'] {
  return {
    enabled: retreat.enabled,
    belowHealth: retreat.belowHealth,
    whenOutnumbered: retreat.whenOutnumbered,
    strategy: retreat.strategy,
    safeHavenRoom: retreat.safeHavenRoom
  };
}

/** `ui.theme` as the file states it, or '' when it follows the options file. */
function themeOf(ui: unknown): ThemePreference | '' {
  if (typeof ui !== 'object' || ui === null) return '';
  const theme = (ui as Record<string, unknown>)['theme'];
  return isThemePreference(theme) ? theme : '';
}

function accentOf(value: unknown, fallback: ProfileAccent): ProfileAccent {
  return PROFILE_ACCENTS.includes(value as ProfileAccent) ? (value as ProfileAccent) : fallback;
}

/** A character whose file could not be read at all: enough to list and fix. */
function blank(id: string): ProfileEditable {
  return {
    id,
    name: id,
    accent: 'cyan',
    theme: '',
    autoConnect: false,
    autoReconnect: true,
    serverName: null,
    target: { host: '', port: 23, encoding: 'cp437' },
    username: '',
    hasPassword: false,
    login: [],
    hangUp: DEFAULT_CONFIG.automation.safety.hangUp,
    retreat: retreatOf(DEFAULT_CONFIG.automation.safety.retreat),
    pvp: DEFAULT_CONFIG.automation.safety.pvp,
    combat: DEFAULT_CONFIG.automation.combat,
    party: DEFAULT_CONFIG.automation.party,
    health: DEFAULT_CONFIG.automation.health,
    movement: DEFAULT_CONFIG.automation.movement,
    remotes: DEFAULT_CONFIG.automation.remotes,
    talk: DEFAULT_CONFIG.automation.talk,
    loops: [],
    inherited: [],
    spells: DEFAULT_CONFIG.automation.spells,
    spellbook: null,
    cureGates: null,
    alerts: DEFAULT_CONFIG.ui.alerts
  };
}

/**
 * One loop as it should read in a file somebody may open afterwards.
 *
 * A stop with no `linger` is written as the bare room name, which is what the
 * template shows and what anybody writing one by hand types; only a stop that
 * waits needs the mapping form. `bounce` is omitted when false rather than
 * written out, for the same reason every other default is: a key restating a
 * default is noise in a file people read.
 */
function loopNode(loop: Loop): Record<string, unknown> {
  return {
    name: loop.name,
    ...(loop.bounce === true ? { bounce: true } : {}),
    stops: loop.stops.map((stop) =>
      stop.linger === undefined
        ? quoted(stop.room)
        : { room: quoted(stop.room), linger: stop.linger }
    )
  };
}

/**
 * A room name in the quotes the template puts it in.
 *
 * Not for correctness — the serializer quotes whatever needs it — but so that a
 * loop the screen wrote and one somebody typed by hand look the same in a
 * file they will open afterwards. `Sewer Tunnel 1/606` is a perfectly good
 * plain scalar; it just is not how the rest of the file spells one.
 */
function quoted(text: string): Scalar<string> {
  const scalar = new Scalar(text);
  scalar.type = Scalar.QUOTE_SINGLE;
  return scalar;
}

/**
 * Brings a loops directory in line with the list a screen holds.
 *
 * One loop, one file, named after the loop — so this is a three-way job:
 * update the file a loop already has, create one for a loop that has none, and
 * remove the file of a loop that is no longer listed. Matched by **name**,
 * which is how a loop is addressed everywhere else in the client, rather than
 * by filename: renaming a loop on the screen should rewrite its file rather
 * than leave the old one behind under the old name.
 *
 * Three things it will not do:
 *
 * - **Touch a file that defines more than one loop.** The client writes one per
 *   file; a file with several is one somebody wrote by hand, and rewriting it
 *   as a single loop would silently delete the others.
 * - **Remove a file it did not recognise.** A file that could not be read is
 *   left exactly where it is: it is somebody's only copy.
 * - **Delete without a backup.** `removeYaml` keeps one, because this runs on
 *   a click and a loop is an evening's work.
 */
export function writeLoops(dir: string, loops: readonly Loop[]): EditResult {
  const existing = readLoopFiles(dir);
  const wanted = new Map(loops.map((loop) => [loop.name.toLowerCase(), loop]));
  const taken = new Set(existing.map((entry) => entry.slug));

  for (const entry of existing) {
    if (wanted.has(entry.name.toLowerCase())) continue;
    const gone = removeYaml(entry.file);
    if (!gone.ok) return gone;
    taken.delete(entry.slug);
  }

  for (const loop of loops) {
    const found = existing.find((entry) => entry.name.toLowerCase() === loop.name.toLowerCase());
    const slug = found?.slug ?? loopFileName(loop.name, taken);
    taken.add(slug);
    const written = editYaml(path.join(dir, `${slug}.yaml`), {
      /*
       * Set key by key rather than replacing the document, so a comment
       * somebody wrote above `stops:` survives an edit made on the screen —
       * the same rule every other file the user owns is edited under.
       */
      mutate: (document) => {
        const node = loopNode(loop);
        for (const [key, value] of Object.entries(node)) document.setIn([key], value);
        if (node['bounce'] === undefined && document.hasIn(['bounce'])) {
          document.deleteIn(['bounce']);
        }
      }
    });
    if (!written.ok) return written;
  }

  return { ok: true };
}

/** What is already in a loops directory: which file holds which loop. */
function readLoopFiles(dir: string): { file: string; slug: string; name: string }[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).sort();
  } catch {
    return [];
  }

  const found: { file: string; slug: string; name: string }[] = [];
  for (const name of names) {
    if (name.startsWith('.') || !/\.ya?ml$/i.test(name)) continue;
    const file = path.join(dir, name);
    const slug = name.replace(/\.ya?ml$/i, '');
    try {
      const loops = readLoops(parse(fs.readFileSync(file, 'utf8')), slug);
      // Exactly one, or this file is not one this screen manages.
      if (loops.length === 1 && loops[0]) found.push({ file, slug, name: loops[0].name });
    } catch {
      // Unreadable: left alone, and left out, so it is never removed.
    }
  }
  return found;
}

/**
 * A comma-separated font stack as the list the schema keeps.
 *
 * One field on the form because a stack is one answer, and four text boxes for
 * one answer is four controls to keep in step. The fallback ladder is appended
 * by `resolveTerminalFonts` regardless, so what is written here is the
 * *preference* and never the whole stack.
 */
function splitNames(value: string): string[] {
  return value
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}
