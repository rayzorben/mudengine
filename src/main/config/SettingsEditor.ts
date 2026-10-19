import fs from 'node:fs';
import path from 'node:path';
import { isMap, isNode, isSeq, parse, Scalar, type Document } from 'yaml';

import { ON_DISK, type EditResult, type YamlFiles } from './YamlFile';
import { grantIsEmpty, type RemoteGrant, type RemoteName } from '../../shared/remotes';
import { unknownWrites, type LayerWrite } from '../../shared/extensions';
import { LoopStore, readLoops, type LoopLists } from './LoopStore';
import { ServerStore, type ServerList } from './ServerStore';
import { directoryNames } from './dirs';
import {
  asServer,
  AUTOMATION_SWITCHES,
  DEFAULT_CONFIG,
  mergeServers,
  normalizeConfig,
  type AutomationSwitch,
  type LoginStep
} from '../../shared/config';
import { type SuppliesConfig, type SupplyItem } from '../../shared/packConfig';
import { type RetreatConfig } from '../../shared/safety';
import { fileSlug, isLoopFileName } from '../../shared/files';
import {
  loopFileName,
  sameLoop,
  type Loop,
  type LoopScope,
  type ScopedLoop
} from '../../shared/loops';
import type { Home } from '../app/home';
import { t } from '../app/i18n';
import { asLowLives, DEFAULT_LOW_LIVES } from '../../shared/lives';
import { asLocateWord, DEFAULT_LOCATE } from '../../shared/locate';
import {
  asReconnectTries,
  DEFAULT_RECONNECT_TRIES,
  ownFleeGotoCommand,
  ownHangPenalties,
  ownLocate,
  ownMobRules,
  PROFILE_ACCENTS,
  resolveProfile,
  type ProfileAccent
} from '../../shared/profiles';
import { isThemePreference, type ThemePreference } from '../../shared/themes';
import type { GlobalDraft, ProfileDraft, ServerDraft } from '../../shared/drafts';
import type { ProfileEditable, SettingsSnapshot, SpellOption } from '../../shared/ipc';
import type { CureGates } from '../../shared/spellcraft';
import type { ConnectionTarget } from '../../shared/types';
import { errorMessage, isRecord, sameJson } from '../../shared/values';
import { statedRoomNames, writtenRoomNames } from '../../shared/roomNicknames';
import { pairsRecord, statedPairs, type StatedPair } from '../../shared/pairs';
import { aliasRefusal, aliasRefusalText, aliasWord } from '../../shared/aliases';
import { statedKeys } from '../../shared/keys';
import { normalizeMobRules, treated, type MobTreatment } from '../../shared/mobRules';
import { mobKey } from '../../shared/world';
import { asArtServer } from '../../shared/artConfig';

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
   * The files as the live stores hold them, and the realms and loops they
   * resolved (todo 137): every read and write goes through the store that owns
   * the file, so a save is live before the file is written. Absent, straight
   * from disk, for a caller with no store running.
   */
  stores?: SettingsStores;
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

/** What the editor reads and writes through: the live stores, or the disk. */
export interface SettingsStores {
  files: YamlFiles;
  servers(): ServerList;
  loops(): LoopLists;
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
    if (differs(block[key], value)) return true;
  }
  return false;
}

/**
 * Whether a draft value says anything its default does not, however deep.
 * Recursive because the designed status line nests its bands: a comparison
 * that stopped at the first level read every design as stated and wrote the
 * shipped one into a file that had said nothing.
 */
function differs(mine: unknown, value: unknown): boolean {
  if (Array.isArray(value)) {
    if (!Array.isArray(mine) || mine.length !== value.length) return true;
    return mine.some((entry, index) => differs(entry, value[index]));
  }
  if (value !== null && typeof value === 'object') {
    if (mine === null || typeof mine !== 'object' || Array.isArray(mine)) return true;
    return statesSomething(mine, value as Record<string, unknown>);
  }
  return mine !== value;
}

export class SettingsEditor {
  private readonly home: Home;
  private readonly spells: SettingsEditorOptions['spells'];
  private readonly stores: SettingsStores;

  constructor(options: SettingsEditorOptions) {
    this.home = options.home;
    this.spells = options.spells;
    const home = options.home;
    this.stores = options.stores ?? {
      files: ON_DISK,
      servers: () => new ServerStore(home),
      loops: () => new LoopStore(home)
    };
  }

  private get files(): YamlFiles {
    return this.stores.files;
  }

  private profilePath(id: string): string {
    return this.home.profile(id).file;
  }

  /** Whether the file is there; one that cannot be read is, and its edit says why. */
  private exists(file: string): boolean {
    try {
      return this.files.read(file) !== null;
    } catch {
      return true;
    }
  }

  /** The refusal for a character with no file, or null. */
  private missing(id: string): EditResult | null {
    return this.exists(this.profilePath(id))
      ? null
      : { ok: false, error: t('errors.settings.characterNotFound', { id }) };
  }

  /** The realms and loops, as the live stores resolved them. */
  private tree(): { servers: ServerList; loops: LoopLists } {
    return { servers: this.stores.servers(), loops: this.stores.loops() };
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
    const found = this.stores.servers().all.map((entry) => entry.server);
    if (found.length === 0) return file;
    return {
      ...(isRecord(file) ? file : {}),
      servers: mergeServers(stated, found)
    };
  }

  /** The options file alone, for an edit that has to leave the rest of it be. */
  private readOptions(): unknown {
    try {
      return parse(this.files.read(this.home.options) ?? '') ?? {};
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
    const creating = !this.exists(file);

    const written = this.files.edit(file, {
      mutate: (document) => {
        document.setIn(['name'], draft.name.length > 0 ? draft.name : id);
        document.setIn(['accent'], draft.accent);
        document.setIn(['autoConnect'], draft.autoConnect);
        document.setIn(['autoReconnect'], draft.autoReconnect);
        document.setIn(['lowLives'], draft.lowLives);
        document.setIn(['reconnectTries'], draft.reconnectTries);
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
          document.setIn(['login', 'steps'], draft.login.map(loginRow));
        } else if (document.hasIn(['login', 'steps'])) {
          document.deleteIn(['login', 'steps']);
        }
        // Off is written; on is the default and removes the key.
        if (!draft.autoLogin) document.setIn(['login', 'enabled'], false);
        else if (document.hasIn(['login', 'enabled'])) document.deleteIn(['login', 'enabled']);
        const loginBlock = document.get('login');
        if (isMap(loginBlock) && loginBlock.items.length === 0) document.deleteIn(['login']);

        // Its own locate word, or null to follow the realm: cleared only when
        // the form could have shown it, as the theme above is.
        if (draft.locate !== null) document.setIn(['locate'], draft.locate);
        else if (asLocateWord(document.get('locate')) !== null) document.deleteIn(['locate']);

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

        // The teleport on the retreat's rule; an empty command writes no key,
        // which is what follows the realm (todo 813).
        if (
          creating ||
          draft.fleeGoto.enabled ||
          document.hasIn(['automation', 'safety', 'fleeGoto'])
        ) {
          document.setIn(['automation', 'safety', 'fleeGoto'], {
            enabled: draft.fleeGoto.enabled,
            belowHealth: draft.fleeGoto.belowHealth,
            ...(draft.fleeGoto.command.length > 0 ? { command: draft.fleeGoto.command } : {})
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
            // Absent leaves it to the realm and then the options file, so null
            // writes no key rather than a copy of what is inherited.
            ...(draft.hangUp.penalties === null ? {} : { penalties: draft.hangUp.penalties }),
            onPlayerInRoom: draft.hangUp.onPlayerInRoom,
            whenNaked: draft.hangUp.whenNaked,
            nakedMargin: draft.hangUp.nakedMargin,
            afterRunSeconds: draft.hangUp.afterRunSeconds
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
          [['automation', 'hunting'], draft.hunting, DEFAULT_CONFIG.automation.hunting],
          [['automation', 'train'], draft.train, DEFAULT_CONFIG.automation.train],
          [['automation', 'quests'], draft.quests, DEFAULT_CONFIG.automation.quests],
          [['automation', 'gear'], draft.gear, DEFAULT_CONFIG.automation.gear],
          [['automation', 'loot'], draft.loot, DEFAULT_CONFIG.automation.loot],
          [['automation', 'drop'], draft.drop, DEFAULT_CONFIG.automation.drop],
          [['automation', 'outgrown'], draft.outgrown, DEFAULT_CONFIG.automation.outgrown],
          [['automation', 'search'], draft.search, DEFAULT_CONFIG.automation.search],
          [['automation', 'banking'], draft.banking, DEFAULT_CONFIG.automation.banking],
          [['automation', 'spells'], draft.spells, DEFAULT_CONFIG.automation.spells],
          [['automation', 'remotes'], draft.remotes, DEFAULT_CONFIG.automation.remotes],
          [['automation', 'afk'], draft.afk, DEFAULT_CONFIG.automation.afk],
          [['automation', 'statline'], draft.statline, DEFAULT_CONFIG.automation.statline],
          [['automation', 'asks'], draft.asks, DEFAULT_CONFIG.automation.asks],
          // Not under `automation:`, because it is not something the client
          // *does* — it is what this player wants to hear about this character.
          [['ui', 'alerts'], draft.alerts, DEFAULT_CONFIG.ui.alerts],
          [['ui', 'rewrites', 'bands'], draft.rewrites.bands, DEFAULT_CONFIG.ui.rewrites.bands]
        ] as const) {
          if (
            creating ||
            document.hasIn(at) ||
            statesSomething(block, defaults as unknown as Record<string, unknown>)
          ) {
            document.setIn(at, { ...block });
          }
        }
        // Judged as the blocks above are, and its rows written as the Self card writes them.
        if (
          creating ||
          document.hasIn(['automation', 'supplies']) ||
          statesSomething({ ...draft.supplies }, { ...DEFAULT_CONFIG.automation.supplies })
        ) {
          writeSupplies(document, draft.supplies);
        }
        // Its own aliases and keys, added to Global's by the overlay, so never a copy of them.
        const aliases = pairsRecord(draft.aliases);
        if (document.hasIn(['automation', 'aliases']) || Object.keys(aliases).length > 0) {
          document.setIn(['automation', 'aliases'], aliases);
        }
        const keys = pairsRecord(draft.keys);
        if (document.hasIn(['keys']) || Object.keys(keys).length > 0)
          document.setIn(['keys'], keys);

        /*
         * The designs are a list, and a list is replaced by an overlay, never
         * merged — the rule the loops settled. So it is judged against what
         * the character would *inherit*, not the shipped six: the form shows
         * the resolved list, and writing that back unchanged would pin
         * Global's list into the character the first time any other field
         * was edited. Equal to the inherited list, the key goes, and the
         * character keeps inheriting; different, the whole list is written.
         */
        const inherited = normalizeConfig(base).ui.rewrites.designs;
        const designs = ['ui', 'rewrites', 'designs'];
        if (creating || differs(draft.rewrites.designs, inherited)) {
          document.setIn(designs, structuredClone(draft.rewrites.designs));
        } else if (document.hasIn(designs)) {
          document.deleteIn(designs);
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
    return writeLoops(this.files, this.home.profile(id).loops, draft.loops);
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
   * Comments survive, like every write here: `applyEdit` uses `parseDocument`,
   * and the file being edited is full of the user's own notes.
   */
  setRemoteGrant(id: string, name: string, grant: RemoteGrant): EditResult {
    const who = name.trim();
    if (who.length === 0) return { ok: false, error: t('errors.settings.remoteNameRequired') };
    const file = this.profilePath(id);
    const missing = this.missing(id);
    if (missing !== null) return missing;

    // Lower-cased, once, the way `normalizeConfig` and `PlayerRegistry` key a
    // name: `Soul` clicked from a `who` listing and `soul` typed in a telepath
    // are one person, and two keys would be one grant that works and one that
    // silently does not.
    const key = who.toLowerCase();
    const deny = [...new Set(grant.deny)];
    const allow = [...new Set(grant.allow)].filter((remote) => !deny.includes(remote));
    const kept: RemoteGrant = { allow, deny, autoInvite: grant.autoInvite };

    return this.files.edit(file, {
      mutate: (document) => {
        if (grantIsEmpty(kept)) {
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
        document.setIn(['automation', 'remotes', 'players', key], document.createNode(kept));
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
    const missing = this.missing(id);
    if (missing !== null) return missing;
    const gang = [...new Set(remotes)];
    return this.files.edit(file, {
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
    const missing = this.missing(id);
    if (missing !== null) return missing;
    return this.files.edit(file, {
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
    const missing = this.missing(id);
    if (missing !== null) return missing;
    return this.files.edit(file, { mutate: (document) => writeSupplyItems(document, items) });
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
    const missing = this.missing(id);
    if (missing !== null) return missing;
    return this.files.edit(file, {
      mutate: (document) => document.setIn(['automation', ...AUTOMATION_SWITCHES[name]], on)
    });
  }

  /**
   * Writes settings under `automation` into the character's file: the player
   * kept an extension's settings (todo 84). The writes are the same list the
   * extension lays over the settings in memory (`withLayer`), and a setting
   * the client does not have is refused rather than written.
   */
  setAutomationValues(id: string, writes: readonly LayerWrite[]): EditResult {
    const file = this.profilePath(id);
    const missing = this.missing(id);
    if (missing !== null) return missing;
    const unknown = unknownWrites(DEFAULT_CONFIG.automation, writes);
    if (unknown.length > 0) {
      const paths = unknown.map(([path]) => path.join('.')).join(', ');
      return { ok: false, error: t('errors.settings.unknownSettings', { paths }) };
    }
    return this.files.edit(file, {
      mutate: (document) => {
        for (const [path, value] of writes) document.setIn(['automation', ...path], value);
      }
    });
  }

  /**
   * This character's own `automation.aliases`, as its file writes them (todo
   * 134): what `alias` marks as the character's rather than Global's.
   */
  ownAliases(id: string): StatedPair[] {
    const file = this.profilePath(id);
    try {
      const text = this.files.read(file);
      if (text === null) throw new Error(t('errors.settings.characterNotFound', { id }));
      const raw: unknown = parse(text);
      const automation = isRecord(raw) && isRecord(raw['automation']) ? raw['automation'] : {};
      return statedPairs(automation['aliases']);
    } catch (error) {
      throw new Error(`could not read ${file}: ${errorMessage(error)}`, { cause: error });
    }
  }

  /**
   * Sets or removes one alias in a character's own file, the `alias`
   * command's write (todo 134). Narrow for `setAutomationSwitch`'s reason.
   * Removing a word the options file states writes it empty, which drops
   * Global's for this character; a word the character alone has goes. A word
   * that would not load is refused and nothing is written. Idempotent.
   */
  setAlias(id: string, word: string, line: string | null): EditResult {
    const file = this.profilePath(id);
    const missing = this.missing(id);
    if (missing !== null) return missing;
    const spelled = aliasWord(word);
    const why = line === null ? null : aliasRefusal(spelled, line);
    if (why !== null) return { ok: false, error: aliasRefusalText(why, t) };
    const options = this.readOptions();
    const automation =
      isRecord(options) && isRecord(options['automation']) ? options['automation'] : {};
    const global = statedPairs(automation['aliases']).some(
      (pair) => aliasWord(pair.name) === spelled && pair.text.trim().length > 0
    );
    const at = ['automation', 'aliases', spelled];
    return this.files.edit(file, {
      mutate: (document) => {
        if (line !== null) document.setIn(at, line.trim());
        else if (global) document.setIn(at, '');
        else document.deleteIn(at);
      },
      // Read back as the client reads it: an alias that loops through a key or another alias loads as nothing.
      verify: (value) => {
        const resolved = resolveProfile(id, value, this.baseSource());
        if (resolved.error !== undefined) return resolved.error;
        const loaded = Object.hasOwn(resolved.profile.config.automation.aliases, spelled);
        return line === null || loaded
          ? null
          : t('errors.settings.aliasNotLoaded', { word: spelled });
      }
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
    const existing = readLoopFiles(this.files, dir);
    const found = existing.find((entry) => entry.name.toLowerCase() === loop.name.toLowerCase());
    const slug = found?.slug ?? loopFileName(loop.name, new Set(existing.map((e) => e.slug)));

    return this.files.edit(path.join(dir, `${slug}.yaml`), {
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
      return this.exists(this.profilePath(owner)) ? this.home.profile(owner).loops : null;
    }
    const id = this.stores.servers().idFor(owner);
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
    return this.files.remove(this.profilePath(id));
  }

  /**
   * One monster's row in a realm's own list, from the Combat card's Treat as
   * (todo 817): replaced or added with `treat`, or taken out with null so the
   * broader lists hold again. The rest of the list is kept as it parses
   * (`normalizeMobRules`), and an emptied list loses its key, as `saveServer`
   * writes it.
   */
  setRealmMobRule(realmName: string, mob: string, treat: MobTreatment | null): EditResult {
    const key = mobKey(mob);
    if (key.length === 0) return { ok: false, error: t('errors.settings.mobRuleNameRequired') };
    const id = this.tree().servers.idFor(realmName);
    if (id === undefined) {
      return { ok: false, error: t('errors.settings.realmNotFound', { name: realmName }) };
    }
    return this.files.edit(this.home.server(id).file, {
      mutate: (document) => {
        const node = document.getIn(['mobRules'], true);
        const rows = normalizeMobRules(isNode(node) ? node.toJSON() : []);
        const held = rows.find((row) => row.mob === key);
        const others = rows.filter((row) => row !== held);
        const next =
          treat === null
            ? others
            : [
                ...others,
                held === undefined ? treated({ mob: key, treat }, treat) : treated(held, treat)
              ];
        if (next.length > 0)
          document.setIn(
            ['mobRules'],
            next.map((row) => ({ ...row }))
          );
        else if (document.hasIn(['mobRules'])) document.deleteIn(['mobRules']);
      }
    });
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

    const result = this.files.edit(scope.file, {
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
          document.setIn(['login'], draft.login.map(loginRow));
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

        /*
         * And the realm's own rules for its monsters, on the same rule: an
         * empty list is what a realm with no key already has, so the key is
         * removed rather than written as `[]`. Rows as the draft parsed them,
         * which states only what each row says (`normalizeMobRules`).
         */
        if (draft.mobRules.length > 0) {
          document.setIn(
            ['mobRules'],
            draft.mobRules.map((row) => ({ ...row }))
          );
        } else if (document.hasIn(['mobRules'])) {
          document.deleteIn(['mobRules']);
        }

        // And whether a hang-up here is charged: absent leaves it to the
        // options file, so null removes the key rather than writing one.
        if (draft.hangPenalties !== null) document.setIn(['hangPenalties'], draft.hangPenalties);
        else if (document.hasIn(['hangPenalties'])) document.deleteIn(['hangPenalties']);

        // And how it is asked where you stand: `rm` is what no key gives, so
        // it is removed, and only a word the form could have shown.
        if (draft.locate !== DEFAULT_LOCATE) document.setIn(['locate'], draft.locate);
        else if (asLocateWord(document.get('locate')) !== null) document.deleteIn(['locate']);

        // And its renamed coins: none stated is the stock names, so no key.
        if (Object.keys(draft.coins).length > 0) document.setIn(['coins'], draft.coins);
        else if (document.hasIn(['coins'])) document.deleteIn(['coins']);

        // And its teleport, literally: empty states none, so no key.
        if (draft.fleeGoto.length > 0) document.setIn(['fleeGoto'], draft.fleeGoto);
        else if (document.hasIn(['fleeGoto'])) document.deleteIn(['fleeGoto']);
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
    return writeLoops(this.files, scope.loops, draft.loops);
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
    this.files.edit(this.home.options, {
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
    const removed = this.files.remove(scope.file);
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
    const file = this.readOptions();
    const config = normalizeConfig(file);
    // As written, for `statedPairs`'s reason: a refused entry is shown, not lost on a save.
    const stated = isRecord(file) ? file : {};
    const loops = this.stores.loops().globalLoops;

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
        cursorStyle: config.terminal.cursorStyle,
        timestamps: config.terminal.timestamps
      },
      ui: {
        fontFamily: config.ui.font.family.join(', '),
        theme: config.ui.theme,
        density: config.ui.density,
        tabs: config.ui.tabs,
        showHud: config.ui.showHud,
        showLogo: config.ui.showLogo,
        consolePalette: config.ui.console.palette,
        consoleKeepDark: config.ui.console.keepDark,
        consoleDarkTheme: config.ui.console.darkTheme,
        vitals: {
          hp: { ...config.ui.vitals.hp },
          mana: { ...config.ui.vitals.mana }
        },
        alerts: {
          // Copied per row, as every list here is: the draft is the form's and
          // the config is the file's, and the two must not share a row object.
          rules: config.ui.alerts.rules.map((rule) => ({ ...rule }))
        },
        rewrites: structuredClone(config.ui.rewrites)
      },
      gameView: { ...config.gameView },
      art: { ...config.art },
      rooms: statedRoomNames(stated['rooms']),
      logging: {
        enabled: config.logging.enabled,
        directory: config.logging.directory,
        capture: config.logging.capture,
        keepDays: config.logging.keepDays,
        fights: config.logging.fights,
        conversations: config.logging.conversations,
        conversationDays: config.logging.conversationDays,
        playerDays: config.logging.playerDays,
        maxBytes: config.logging.maxBytes
      },
      automation: {
        enabled: config.automation.enabled,
        onEnterRealm: [...config.automation.onEnterRealm],
        onPartyChange: config.automation.onPartyChange,
        idle: { ...config.automation.idle },
        pacing: { ...config.automation.pacing },
        walk: { ...config.automation.walk },
        hunting: { ...config.automation.hunting },
        hangUp: { ...config.automation.safety.hangUp },
        retreat: retreatOf(config.automation.safety.retreat),
        fleeGoto: { ...config.automation.safety.fleeGoto },
        pvp: { ...config.automation.safety.pvp },
        combat: { ...config.automation.combat },
        party: { ...config.automation.party },
        health: { ...config.automation.health },
        movement: { ...config.automation.movement },
        train: { ...config.automation.train, wanted: { ...config.automation.train.wanted } },
        quests: { ...config.automation.quests },
        // Deep, because the sets and their `wear` lists are the draft's
        // own to edit: a shallow copy hands the form the config's arrays.
        gear: {
          ...config.automation.gear,
          sets: config.automation.gear.sets.map((set) => ({ ...set, wear: [...set.wear] })),
          offRound: { ...config.automation.gear.offRound }
        },
        spells: { ...config.automation.spells },
        loot: { ...config.automation.loot, items: [...config.automation.loot.items] },
        drop: { ...config.automation.drop, items: [...config.automation.drop.items] },
        outgrown: { ...config.automation.outgrown },
        search: { ...config.automation.search },
        banking: { ...config.automation.banking },
        supplies: structuredClone(config.automation.supplies),
        remotes: { ...config.automation.remotes },
        afk: { ...config.automation.afk },
        talk: { ...config.automation.talk },
        statline: { ...config.automation.statline },
        asks: { ...config.automation.asks },
        aliases: statedPairs(
          isRecord(stated['automation']) ? stated['automation']['aliases'] : null
        )
      },
      loops,
      keys: statedKeys(stated['keys']),
      extensions: { ...config.extensions }
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
    const artServer = asArtServer(draft.art.server);
    if (artServer === null) {
      return {
        ok: false,
        error: t('errors.settings.artServerInvalid', { server: draft.art.server })
      };
    }
    const written = this.files.edit(this.home.options, {
      mutate: (document) => {
        const set = (path: readonly string[], value: unknown): void => {
          document.setIn([...path], value);
        };

        set(['connection', 'host'], draft.connection.host);
        set(['connection', 'port'], draft.connection.port);
        set(['connection', 'encoding'], draft.connection.encoding);
        // No account and no autoconnect here: both belong to a character, and
        // `dropAnonymousConnection` has already taken any old ones out.
        set(['connection', 'login', 'steps'], draft.connection.login.steps.map(loginRow));

        set(['terminal', 'font', 'family'], splitNames(draft.terminal.fontFamily));
        set(['terminal', 'font', 'size'], draft.terminal.fontSize);
        set(['terminal', 'scrollback'], draft.terminal.scrollback);
        set(['terminal', 'cursorBlink'], draft.terminal.cursorBlink);
        set(['terminal', 'cursorStyle'], draft.terminal.cursorStyle);
        set(['terminal', 'timestamps'], draft.terminal.timestamps);

        set(['ui', 'font', 'family'], splitNames(draft.ui.fontFamily));
        set(['ui', 'theme'], draft.ui.theme);
        set(['ui', 'density'], draft.ui.density);
        set(['ui', 'tabs'], draft.ui.tabs);
        set(['ui', 'showHud'], draft.ui.showHud);
        set(['ui', 'showLogo'], draft.ui.showLogo);
        set(['ui', 'console', 'palette'], draft.ui.consolePalette);
        set(['ui', 'console', 'keepDark'], draft.ui.consoleKeepDark);
        set(['ui', 'console', 'darkTheme'], draft.ui.consoleDarkTheme);
        for (const vital of ['hp', 'mana'] as const) {
          set(['ui', 'vitals', vital, 'caution'], draft.ui.vitals[vital].caution);
          set(['ui', 'vitals', vital, 'critical'], draft.ui.vitals[vital].critical);
        }
        /*
         * The player's own rows. `saveProfile` has written these since they
         * were built and this did not, so a row typed on the Global page was
         * read back into the draft, drawn in the form and dropped on the next
         * save — which is what a starting point that cannot be set looks like
         * from the outside (todo 02).
         *
         * Cloned whole, like `ui.rewrites` below and for its reason: a row is
         * an object, and `setIn` would otherwise put the draft's own live
         * objects into the document.
         */
        set(['ui', 'alerts', 'rules'], structuredClone(draft.ui.alerts.rules));
        set(['ui', 'rewrites'], structuredClone(draft.ui.rewrites));

        set(['gameView', 'dock'], draft.gameView.dock);
        set(['gameView', 'opacity'], draft.gameView.opacity);
        set(['art', 'enabled'], draft.art.enabled);
        set(['art', 'server'], artServer);
        // Only when changed, so a hand-written list keeps its layout and comments.
        const rooms = document.get('rooms', true);
        const written = writtenRoomNames(draft.rooms);
        const stated = writtenRoomNames(statedRoomNames(isSeq(rooms) ? rooms.toJSON() : null));
        if (!sameJson(stated, written)) set(['rooms'], written);
        set(['logging', 'enabled'], draft.logging.enabled);
        set(['logging', 'directory'], draft.logging.directory);
        set(['logging', 'capture'], draft.logging.capture);
        set(['logging', 'keepDays'], draft.logging.keepDays);
        set(['logging', 'fights'], draft.logging.fights);
        set(['logging', 'conversations'], draft.logging.conversations);
        set(['logging', 'conversationDays'], draft.logging.conversationDays);
        set(['logging', 'playerDays'], draft.logging.playerDays);
        set(['logging', 'maxBytes'], draft.logging.maxBytes);

        set(['automation', 'enabled'], draft.automation.enabled);
        set(['automation', 'onEnterRealm'], [...draft.automation.onEnterRealm]);
        set(['automation', 'onPartyChange'], draft.automation.onPartyChange);
        set(['automation', 'idle'], { ...draft.automation.idle });
        set(['automation', 'pacing'], { ...draft.automation.pacing });
        set(['automation', 'walk'], { ...draft.automation.walk });
        set(['automation', 'safety', 'hangUp'], { ...draft.automation.hangUp });
        set(['automation', 'safety', 'retreat'], { ...draft.automation.retreat });
        set(['automation', 'safety', 'fleeGoto'], { ...draft.automation.fleeGoto });
        set(['automation', 'safety', 'pvp'], { ...draft.automation.pvp });
        set(['automation', 'combat'], { ...draft.automation.combat });
        set(['automation', 'party'], { ...draft.automation.party });
        set(['automation', 'health'], { ...draft.automation.health });
        set(['automation', 'movement'], { ...draft.automation.movement });
        set(['automation', 'hunting'], { ...draft.automation.hunting });
        set(['automation', 'train'], {
          ...draft.automation.train,
          wanted: { ...draft.automation.train.wanted }
        });
        set(['automation', 'quests'], { ...draft.automation.quests });
        set(['automation', 'gear'], { ...draft.automation.gear });
        set(['automation', 'spells'], { ...draft.automation.spells });
        set(['automation', 'loot'], { ...draft.automation.loot });
        set(['automation', 'drop'], { ...draft.automation.drop });
        set(['automation', 'outgrown'], { ...draft.automation.outgrown });
        set(['automation', 'banking'], { ...draft.automation.banking });
        writeSupplies(document, draft.automation.supplies);
        set(['automation', 'remotes'], { ...draft.automation.remotes });
        set(['automation', 'afk'], { ...draft.automation.afk });
        set(['automation', 'statline'], { ...draft.automation.statline });
        set(['automation', 'asks'], { ...draft.automation.asks });
        set(['automation', 'aliases'], pairsRecord(draft.automation.aliases));
        set(['keys'], pairsRecord(draft.keys));
        // Name by name, so the block's own lines and comments stay where they are.
        for (const [name, on] of Object.entries(draft.extensions)) set(['extensions', name], on);
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
    return writeLoops(this.files, this.home.globalLoops, draft.loops);
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
      let raw: unknown;
      try {
        const text = this.files.read(file);
        if (text === null) continue;
        raw = parse(text);
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
        autoLogin: login['enabled'] !== false,
        lowLives: asLowLives(record['lowLives']),
        reconnectTries: asReconnectTries(record['reconnectTries']),
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
              .map((step) => ({
                when: text(step['when']),
                send: text(step['send']),
                ...(step['repeat'] === true ? { repeat: true } : {})
              }))
              .filter((step) => step.when.length > 0)
          : [],
        // Its own, read raw for `login`'s reason: the resolved one may be the realm's.
        locate: ownLocate(record),
        /*
         * Falling back to the shipped defaults rather than to numbers written
         * out here. A default restated in a second place is a default that goes
         * stale the first time the first one changes, which is the rule the
         * options template already keeps: defaults live in exactly one place.
         */
        // The character's own answer about penalties, read raw as `mobRules`
        // is below: the resolved one may be the realm's or the options file's.
        hangUp: {
          ...(effective?.automation.safety.hangUp ?? DEFAULT_CONFIG.automation.safety.hangUp),
          penalties: ownHangPenalties(record)
        },
        retreat: retreatOf(
          effective?.automation.safety.retreat ?? DEFAULT_CONFIG.automation.safety.retreat
        ),
        // Its own command, read raw: the resolved one may be the realm's.
        fleeGoto: {
          ...(effective?.automation.safety.fleeGoto ?? DEFAULT_CONFIG.automation.safety.fleeGoto),
          command: ownFleeGotoCommand(record) ?? ''
        },
        pvp: effective?.automation.safety.pvp ?? DEFAULT_CONFIG.automation.safety.pvp,
        /*
         * The resolved combat block, except for the monster list, which is
         * the character's **own** rows from the file as written (todo 01).
         *
         * `mobRules` is the one list here merged across the three scopes
         * rather than replaced, so the resolved one holds the realm's rows and
         * the global file's as well. Seeding the form with those and saving it
         * back would write them into this character's own file — pinning down
         * rules it was only inheriting, so that changing the realm's list
         * afterwards would silently not reach it. The same distinction
         * `login.steps` above keeps, for the same reason.
         */
        combat: {
          ...(effective?.automation.combat ?? DEFAULT_CONFIG.automation.combat),
          mobRules: ownMobRules(record)
        },
        party: effective?.automation.party ?? DEFAULT_CONFIG.automation.party,
        health: effective?.automation.health ?? DEFAULT_CONFIG.automation.health,
        movement: effective?.automation.movement ?? DEFAULT_CONFIG.automation.movement,
        hunting: effective?.automation.hunting ?? DEFAULT_CONFIG.automation.hunting,
        train: effective?.automation.train ?? DEFAULT_CONFIG.automation.train,
        quests: effective?.automation.quests ?? DEFAULT_CONFIG.automation.quests,
        gear: effective?.automation.gear ?? DEFAULT_CONFIG.automation.gear,
        loot: effective?.automation.loot ?? DEFAULT_CONFIG.automation.loot,
        drop: effective?.automation.drop ?? DEFAULT_CONFIG.automation.drop,
        outgrown: effective?.automation.outgrown ?? DEFAULT_CONFIG.automation.outgrown,
        search: effective?.automation.search ?? DEFAULT_CONFIG.automation.search,
        banking: effective?.automation.banking ?? DEFAULT_CONFIG.automation.banking,
        supplies: effective?.automation.supplies ?? DEFAULT_CONFIG.automation.supplies,
        remotes: effective?.automation.remotes ?? DEFAULT_CONFIG.automation.remotes,
        afk: effective?.automation.afk ?? DEFAULT_CONFIG.automation.afk,
        talk: effective?.automation.talk ?? DEFAULT_CONFIG.automation.talk,
        statline: effective?.automation.statline ?? DEFAULT_CONFIG.automation.statline,
        asks: effective?.automation.asks ?? DEFAULT_CONFIG.automation.asks,
        // Its own, read raw: the resolved list holds Global's too.
        aliases: statedPairs(
          isRecord(record['automation']) ? record['automation']['aliases'] : null
        ),
        keys: statedPairs(record['keys']),
        macroBase: { keys: config.keys, aliases: config.automation.aliases },
        rewrites: effective?.ui.rewrites ?? DEFAULT_CONFIG.ui.rewrites,
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
        const raw = parse(this.files.read(this.home.profile(id).file) ?? '');
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
  tree: { servers: ServerList; loops: LoopLists },
  serverName: string | null
): ScopedLoop[] {
  const id = serverName === null ? undefined : tree.servers.idFor(serverName);
  const fromServer = id === undefined ? [] : tree.loops.forServer(id);
  return [
    ...fromServer.map((loop) => ({ loop, scope: 'server' as const, owner: serverName ?? '' })),
    ...tree.loops.globalLoops.map((loop) => ({ loop, scope: 'global' as const }))
  ];
}

/** The supplies block's switch and figures, then its list (`writeSupplyItems`). */
function writeSupplies(document: Document, supplies: SuppliesConfig): void {
  const { enabled, cashBuffer, dearerSteps, items } = supplies;
  document.setIn(['automation', 'supplies', 'enabled'], enabled);
  document.setIn(['automation', 'supplies', 'cashBuffer'], cashBuffer);
  document.setIn(['automation', 'supplies', 'dearerSteps'], dearerSteps);
  writeSupplyItems(document, items);
}

/**
 * A supplies list as every writer puts it on disk: a block sequence of flow
 * rows, so a file somebody reads by hand says one item per line, and no `at`
 * where no room was chosen.
 */
function writeSupplyItems(document: Document, items: readonly SupplyItem[]): void {
  const rows = items.map((item) => ({
    name: item.name,
    min: item.min,
    max: item.max,
    shop: item.shop,
    ...(item.at === null ? {} : { at: { map: item.at.map, room: item.at.room } })
  }));
  // A node made here, so the rows are styled whether or not a list was there.
  const list = document.createNode(rows);
  if (isSeq(list)) {
    list.flow = false;
    for (const row of list.items) if (isMap(row)) row.flow = true;
  }
  document.setIn(['automation', 'supplies', 'items'], list);
}

/**
 * One login row as it is written to disk.
 *
 * Projected field by field rather than spread, so a field the draft happens to
 * carry cannot leak into the player's file. `repeat` is written only when it is
 * on: an ordinary menu row stays the two keys it has always been, and a file
 * somebody reads is not full of `repeat: false`.
 */
function loginRow(step: LoginStep): Record<string, unknown> {
  return { when: step.when, send: step.send, ...(step.repeat ? { repeat: true } : {}) };
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
    belowMana: retreat.belowMana,
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
    autoLogin: true,
    lowLives: DEFAULT_LOW_LIVES,
    reconnectTries: DEFAULT_RECONNECT_TRIES,
    serverName: null,
    target: { host: '', port: 23, encoding: 'cp437' },
    username: '',
    hasPassword: false,
    login: [],
    locate: null,
    hangUp: { ...DEFAULT_CONFIG.automation.safety.hangUp, penalties: null },
    retreat: retreatOf(DEFAULT_CONFIG.automation.safety.retreat),
    fleeGoto: DEFAULT_CONFIG.automation.safety.fleeGoto,
    pvp: DEFAULT_CONFIG.automation.safety.pvp,
    combat: DEFAULT_CONFIG.automation.combat,
    party: DEFAULT_CONFIG.automation.party,
    health: DEFAULT_CONFIG.automation.health,
    movement: DEFAULT_CONFIG.automation.movement,
    hunting: DEFAULT_CONFIG.automation.hunting,
    train: DEFAULT_CONFIG.automation.train,
    quests: DEFAULT_CONFIG.automation.quests,
    gear: DEFAULT_CONFIG.automation.gear,
    loot: DEFAULT_CONFIG.automation.loot,
    drop: DEFAULT_CONFIG.automation.drop,
    outgrown: DEFAULT_CONFIG.automation.outgrown,
    search: DEFAULT_CONFIG.automation.search,
    banking: DEFAULT_CONFIG.automation.banking,
    supplies: DEFAULT_CONFIG.automation.supplies,
    remotes: DEFAULT_CONFIG.automation.remotes,
    afk: DEFAULT_CONFIG.automation.afk,
    talk: DEFAULT_CONFIG.automation.talk,
    statline: DEFAULT_CONFIG.automation.statline,
    asks: DEFAULT_CONFIG.automation.asks,
    aliases: [],
    keys: [],
    macroBase: { keys: DEFAULT_CONFIG.keys, aliases: DEFAULT_CONFIG.automation.aliases },
    rewrites: DEFAULT_CONFIG.ui.rewrites,
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
 * A stop with no `linger` and no clock is written as the bare room name, which
 * is what the template shows and what anybody writing one by hand types; only
 * a stop that waits or states its own regeneration clock (`every`, todo 15)
 * needs the mapping form. `bounce` is omitted when false rather than written
 * out, for the same reason every other default is: a key restating a default
 * is noise in a file people read.
 */
function loopNode(loop: Loop): Record<string, unknown> {
  return {
    name: loop.name,
    ...(loop.bounce === true ? { bounce: true } : {}),
    ...(loop.prefer === true ? { prefer: true } : {}),
    ...(loop.pathFile === undefined ? {} : { pathFile: loop.pathFile }),
    stops: loop.stops.map((stop) =>
      stop.linger === undefined && stop.every === undefined
        ? quoted(stop.room)
        : {
            room: quoted(stop.room),
            ...(stop.linger === undefined ? {} : { linger: stop.linger }),
            ...(stop.every === undefined ? {} : { every: stop.every })
          }
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
export function writeLoops(files: YamlFiles, dir: string, loops: readonly Loop[]): EditResult {
  const existing = readLoopFiles(files, dir);
  const wanted = new Map(loops.map((loop) => [loop.name.toLowerCase(), loop]));
  const taken = new Set(existing.map((entry) => entry.slug));

  for (const entry of existing) {
    if (wanted.has(entry.name.toLowerCase())) continue;
    const gone = files.remove(entry.file);
    if (!gone.ok) return gone;
    taken.delete(entry.slug);
  }

  for (const loop of loops) {
    const found = existing.find((entry) => entry.name.toLowerCase() === loop.name.toLowerCase());
    /*
     * A file that already reads as this loop is left as it is: rewritten, a
     * loop somebody typed by hand loses its comments and its flow list on
     * every save of the page, whichever loop the save was for.
     */
    if (found !== undefined && sameLoop(found.loop, loop)) continue;
    const slug = found?.slug ?? loopFileName(loop.name, taken);
    taken.add(slug);
    const written = files.edit(path.join(dir, `${slug}.yaml`), {
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
function readLoopFiles(
  files: YamlFiles,
  dir: string
): { file: string; slug: string; name: string; loop: Loop }[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).sort();
  } catch {
    return [];
  }

  const found: { file: string; slug: string; name: string; loop: Loop }[] = [];
  for (const name of names) {
    if (!isLoopFileName(name)) continue;
    const file = path.join(dir, name);
    const slug = name.replace(/\.ya?ml$/i, '');
    try {
      const loops = readLoops(parse(files.read(file) ?? ''), slug);
      // Exactly one, or this file is not one this screen manages.
      if (loops.length === 1 && loops[0]) {
        found.push({ file, slug, name: loops[0].name, loop: loops[0] });
      }
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
