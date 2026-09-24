/**
 * Bringing an older layout across, once, and saying what it did.
 *
 * The client's files used to be a directory of loose ones — an options file
 * with `servers:` and `automation.loops` inside it, characters as
 * `profiles/<id>.yaml`, and, while developing, all of it inside the source
 * checkout. They are a tree now (see `home.ts`), and the project is unreleased,
 * so there is no compatibility to keep and nothing to be gained by reading both
 * shapes for ever: the files are **moved**, and the old shape stops existing.
 *
 * That makes this the most dangerous code in the repository, because it is the
 * only code that moves files somebody else wrote. Four rules:
 *
 * - **Nothing is overwritten.** Every step checks the destination first and
 *   leaves it alone if something is already there. Run twice, it does nothing
 *   the second time; interrupted halfway, it finishes on the next launch.
 * - **Comments survive.** A block lifted out of the options file is moved as
 *   its *node*, not as data re-serialised from a plain object — `yaml` keeps
 *   comments on nodes, and in this repo the comments are the documentation. A
 *   server's `# Added by the server itself on 2026-08-27` is the only record of
 *   why that menu answer is there.
 * - **Nothing is said about what is inside.** These files hold passwords. Every
 *   message names a path and a count.
 * - **Every step is reported.** A migration that moved somebody's characters
 *   and said nothing is indistinguishable from one that lost them.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  Document,
  parseDocument,
  isMap,
  isScalar,
  isSeq,
  Scalar,
  type Node,
  type Pair,
  type YAMLMap,
  type YAMLSeq
} from 'yaml';

import { fileSlug } from '../../shared/files';
import { isRecord } from '../../shared/values';
import { credentialsNamed } from '../../shared/login';
import { asLoops, loopCategory, type Loop } from '../../shared/loops';
import { t } from '../app/i18n';
import { ACTIONABLE_REMOTES } from '../../shared/remotes';
import { DEFAULT_CONFIG, normalizeBands } from '../../shared/config';
import {
  DEFAULT_ALERT_DEBOUNCE_SECONDS,
  NOTICE_CHANNELS,
  type AlertRule
} from '../../shared/notifications';
import { DEFAULT_REWRITES, type RewriteDesign, type RewriteEntity } from '../../shared/rewrites';
import { DEFAULT_INTERNAL } from '../../shared/internal';
import { DENOMINATIONS } from '../../shared/character';
import { SERVER_FILE, type Home } from '../app/home';
import { directoryNames } from './dirs';
import { discoveryKey, type Discovery } from '../../shared/memory';
import { realmKey } from '../world/RealmLore';
import type { ShippedWorld } from '../../shared/worlds';

export interface MigrationOptions {
  home: Home;
  /**
   * Where an options file may be sitting from before the tree existed, most
   * likely first. The first that exists is brought across with everything
   * beside it.
   */
  legacyOptions: readonly string[];
  /**
   * Files that must be left where they are, whatever else moves.
   *
   * The shipped templates. In development the old layout put the client's
   * files *inside the source checkout*, in the same directory as
   * `default.yaml`, `internal.yaml` and `profile.default.yaml` — so a
   * migration that moved everything beside the options file would carry off
   * three files belonging to the repository rather than to the player. It did,
   * once: `internal.yaml` is both the template and, in a development run, the
   * live file, which is the other half of why this layout had to change.
   */
  keep?: readonly string[];
  /**
   * The shipped options template, so a block this migration *renames* can be
   * given the current annotation rather than the one describing the shape it
   * replaced. `reconcileWithTemplate` deliberately never reaches inside a
   * top-level block, so nothing else would.
   */
  template?: string;
  /**
   * The shipped tuning template, for the same reason and about the other file
   * somebody hand-edits: `internal.yaml` carries a paragraph per key, and a
   * paragraph naming a command the server does not have is documentation that
   * is wrong in the file it documents.
   */
  internalTemplate?: string;
  /**
   * The shipped shelf of loops, for the one migration that has to recognise a
   * loop somebody copied off it. A function rather than the list, so a client
   * with no copied loop on disk never reads four hundred of them at startup.
   */
  loopShelf?: () => readonly Loop[];
  /** Said out loud: into the console and the terminal. */
  note: (message: string) => void;
}

/**
 * The realm `GMUD (5X)` was, in the three strings needed to recognise the copy
 * this client itself seeded onto somebody's disk.
 *
 * **Literals rather than constants, deliberately.** Nothing in the client
 * refers to this realm any more — it left the distribution on 2026-09-05 — so
 * there is no constant left to point at, and inventing one would be a name
 * suggesting the realm still exists somewhere. These three strings exist only
 * so `theGmudRealmLeft` can tell the seeded copy from a realm a player has
 * since made their own under the same directory name.
 */
const GMUD_REALM_ID = 'gmud-5x';
const GMUD_REALM_NAME = 'GMUD (5X)';
const GMUD_REALM_HOST = '70.176.151.219';

/** What the state directories are called, so a legacy root moves whole. */
const STATE = ['memory', 'fights', 'realms', 'logs'];
const STATE_FILES = ['internal.yaml', 'mob-lore.json', 'workspace.json'];

/**
 * Every file this run has parsed, by path, as the text it was parsed from.
 *
 * Sixty-seven steps each read and parsed every file they might touch — the
 * options file and each profile, on every launch — and that was most of the
 * two seconds the window waited on this (todo 02, 2026-09-23: 12ms a parse of
 * a 51 KB options file, 3.6ms a clone). A step is handed a clone, so one that
 * changes a document and answers *unchanged* leaves no trace, exactly as a
 * fresh parse did; the text is the key and a write drops the entry, so what a
 * step reads is always a parse of what is on disk. Only for one run.
 */
let parsed: Map<string, { text: string; document: Document }> | null = null;

/**
 * Brings whatever is on disk up to the current shape. Safe to call every launch.
 */
export function migrateHome(options: MigrationOptions): void {
  parsed = new Map();
  try {
    migrateAll(options);
  } finally {
    parsed = null;
  }
}

function migrateAll(options: MigrationOptions): void {
  const { home, note } = options;

  adoptLegacyRoot(options);
  foldProfilesIntoDirectories(home, note);
  liftServersOutOfOptions(home, note);
  liftLoopsOutOfOptions(home, note);
  liftLoopsOutOfProfiles(home, note);
  dropStandUpThresholds(home, note);
  dropTheRoundMacro(home, note);
  dropDiagnosticsPreference(home, note);
  pinTheLoopShelf(home, note);
  peersBecameRemotes(options);
  statedPartyRemotes(home, note);
  dropAnonymousConnection(home, note);
  statedDoorForcing(home, note);
  keptTheConversationLog(home, note);
  theWardSwitchMovedToHealth(home, note);
  statedTheNewAutomation(home, note);
  mergedBuffsIntoBlessings(home, note);
  keyedBlessingsOnSpell(home, note);
  askedTheBankOnEntry(home, note);
  stoppedAnnouncingTheLook(home, note);
  pinTheGearButton(home, note);
  statedTheStepNudge(home, note);
  statedTheNudgeWindow(home, note);
  statedTheRosterCap(home, note);
  mapDensityHasTwoEnds(home, note);
  realmOwnsTheDatabase(home, note);
  shopStockBecameTheRealms(home, note);
  splitTheHealSpell(home, note);
  statedTheEntityPredicates(home, note);
  /*
   * **Before `statedTheRestCeiling`**, which writes `restTo: 0` into every file
   * that states `health:` without one. Run the other way round, a file whose
   * ceiling was `loopResumeAt: 0.9` would have `restTo: 0` written first, and
   * the fold would then see the partner as stated and throw the 0.9 away --
   * turning a deliberate resume floor into the single sit-down, silently. Same
   * hazard and same answer as `dropTheRoundMacro` before
   * `statedTheEntityPredicates`.
   */
  restIsOnePair(home, note);
  statedTheRestCeiling(home, note);
  statedTheTrapRest(home, note);
  theEscapeIsADirection(home, note, options.template);
  theLoopSettlesAfterAnEscape(home, note, options.internalTemplate);
  statedAutoReconnect(home, note);
  statedTheLightAndSupplies(home, note);
  statedTheConditionWaits(home, note);
  statedTheKeyPickup(home, note);
  theTuningBlockGainedKeys(home, note, options.internalTemplate);
  theGmudRealmLeft(home, note);
  theDatabasesWereZipped(home, note);
  theWorldsAreBundled(home, note);
  statedTheMark(home, note);
  statedTheDarkConsole(home, note, options.template);
  statedTheConsolePalette(home, note, options.template);
  theDoorsOpenByDefault(home, note);
  alertSettingsBecameRows(home, note);
  statedTheStatusLine(home, note, options.template);
  theLineBecameARewrite(home, note, options.template);
  theRewritesBecameAList(home, note, options.template);
  quietedTheStatusLineAsks(home, note);
  loopsTookTheirRecordedNames(home, note, options.loopShelf);
  theTransportBecameOneButton(home, note, options.internalTemplate);
  theRoomRemoteFollowsWhere(home, note);
  theCoinsCanBeShed(home, note);
  statedTheHideForOpener(home, note);
  statedTheGearRecovery(home, note);
  statedTheRestNextDoor(home, note);
  statedTheSpellChoice(home, note);
  statedTheTraining(home, note);
  theCombatFloorWent(home, note);
  theFightCostWent(home, note);
  statedTheLevelling(home, note);
  statedThePotionRules(home, note);
  statedTheRecoveryBounds(home, note);
  statedTheAlertRules(home, note);
  theCombatAndPotionSettingsWent(home, note);
  theMobListsBecameRules(home, note);
  statedTheMobRules(home, note);
  alertRowsBecameEvents(home, note);
  theDesktopSwitchesBecameRows(home, note);
  theToolbarGainedBack(home, note, options.internalTemplate);
  statedTheHunting(home, note);
  theTalkHoldGrew(home, note);
  statedTheReplanDrift(home, note);
  theActionsBecameAFamily(home, note);
  statedTheLightWait(home, note);
  pinTheBlessSwitch(home, note);
  theAccountJoinedTheScript(home, note);
  thePagerRepeats(home, note);
  theHangPenaltyIsTheRealms(home, note);
}

/**
 * The account's two prompts become rows in the login script (2026-09-17).
 *
 * They were answered from the *block vocabulary* — `prompt-username` and
 * `prompt-password`, which are two regexes over this realm family's own
 * wording. Every other prompt on the way in was already described by the
 * realm's own script, so a BBS that asks `Enter your ID:` had a client that
 * could answer its menus and not its login, and no way for the player to say
 * so. The rows now say it: `{user}` and `{password}` stand in for the values,
 * which stay on the character's file.
 *
 * Which means a script somebody already has answers one prompt fewer than it
 * used to, so every file that states one gets the pair written in — at the
 * front, because that is where a BBS asks.
 *
 * Three things this will not do:
 *
 * - **Never twice.** A list already naming a credential anywhere is one
 *   somebody has written rows for; a second pair would answer the same prompt
 *   twice and the second answer would land at whatever came next. That is what
 *   makes this idempotent, which a list entry is not for free.
 * - **Never into an empty list.** A stated but empty `login:` means *this realm
 *   has no menus*, and on a realm file it also means the options file's script
 *   is what a character there inherits (`resolveProfile`). Writing two rows in
 *   would turn that inheritance off and take the menus with it.
 * - **Never into a file that states no script at all.** It inherits one, and
 *   the file it inherits from is in this same list.
 */
function theAccountJoinedTheScript(home: Home, note: (message: string) => void): void {
  const targets: Array<{ file: string; at: string[] }> = [
    { file: home.options, at: ['connection', 'login', 'steps'] },
    // The realm's own script, which is where a script belongs and so where
    // almost every one of these will be.
    ...directories(home.serversDir).map((id) => ({ file: home.server(id).file, at: ['login'] })),
    // And a character that states its own to differ — a second character in a
    // different slot, which replaces the realm's list rather than adding to it.
    ...directories(home.profilesDir).map((id) => ({
      file: home.profile(id).file,
      at: ['login', 'steps']
    }))
  ];

  const stated: string[] = [];
  for (const { file, at } of targets) {
    edit(file, (document) => {
      const steps = document.getIn(at, true);
      if (!isSeq(steps) || steps.items.length === 0) return false;
      if (steps.items.some(namesAnAccount)) return false;

      const user = document.createNode({ when: 'Please enter your username', send: '{user}' });
      const password = document.createNode({
        when: 'Please enter your password',
        send: '{password}'
      });
      (user as YAMLMap<unknown, unknown>).commentBefore = ACCOUNT_STEPS_COMMENT;
      steps.items.unshift(user, password);
      stated.push(file);
      return true;
    });
  }

  if (stated.length === 0) return;
  const params = { count: stated.length, fileList: stated.join(', ') };
  note(
    stated.length === 1
      ? t('notices.migration.accountJoinedTheScript.one', params)
      : t('notices.migration.accountJoinedTheScript.many', params)
  );
}

/**
 * A pager row answers every screenful (2026-09-17).
 *
 * `(N)onstop, (Q)uit, or (C)ontinue?` is not a menu. A menu is asked once and
 * answering it moves on, which is why every row is spent when it is used; a
 * pager is asked once per screenful, so the answer *working* is exactly what
 * brings it back. Measured on bearfather: the script's `Q` stopped the first
 * pageful, the BBS printed the text that follows it — registry notice, credits,
 * three `Fantasy awaits you` banners — paged that too, asked again, and the
 * sequence sat at the second prompt for the rest of the connection with the row
 * already spent.
 *
 * Only rows whose wording is a pager's, and only where the flag is not already
 * stated. The three below are the ones this client has seen on the wire;
 * anything else is the player's to tick, which is what the checkbox beside each
 * row is for. A `when` is matched case-insensitively, as the automator matches
 * it.
 *
 * **Never a row that sends a credential**, however it is worded: the account's
 * once-per-connection is what stops a password being retried into a lockout.
 */
function thePagerRepeats(home: Home, note: (message: string) => void): void {
  const targets: Array<{ file: string; at: string[] }> = [
    { file: home.options, at: ['connection', 'login', 'steps'] },
    ...directories(home.serversDir).map((id) => ({ file: home.server(id).file, at: ['login'] })),
    ...directories(home.profilesDir).map((id) => ({
      file: home.profile(id).file,
      at: ['login', 'steps']
    }))
  ];

  const stated: string[] = [];
  for (const { file, at } of targets) {
    edit(file, (document) => {
      const steps = document.getIn(at, true);
      if (!isSeq(steps)) return false;
      let changed = false;
      for (const item of steps.items) {
        if (!isMap(item)) continue;
        if (item.get('repeat') !== undefined) continue;
        if (namesAnAccount(item)) continue;
        const when = item.get('when');
        if (typeof when !== 'string' || !isPagerPrompt(when)) continue;
        item.set('repeat', true);
        changed = true;
      }
      if (changed) stated.push(file);
      return changed;
    });
  }

  if (stated.length === 0) return;
  const params = { count: stated.length, fileList: stated.join(', ') };
  note(
    stated.length === 1
      ? t('notices.migration.pagerRepeats.one', params)
      : t('notices.migration.pagerRepeats.many', params)
  );
}

/**
 * Whether a row's `when` is a pager's question rather than a menu's.
 *
 * The wordings this client has met, not a guess at the shape: a prompt ending
 * in a question mark is most menus too. Each is the distinctive middle of the
 * sentence, so the surrounding punctuation and the `[More]` decoration a given
 * BBS puts round it do not matter.
 */
function isPagerPrompt(when: string): boolean {
  const text = when.toLowerCase();
  return [
    // Worldgroup / Major BBS, which is what MajorMUD sits behind.
    'or (c)ontinue',
    // The same pager without the quit option, and Synchronet's.
    '(c)ontinue, (n)onstop',
    'more [y/n]'
  ].some((wording) => text.includes(wording));
}

/** Whether one `{ when, send }` row already asks for a credential. */
function namesAnAccount(item: unknown): boolean {
  if (!isMap(item)) return false;
  const send = item.get('send');
  return typeof send === 'string' && credentialsNamed(send).length > 0;
}

/** The template's own words, so a migrated file reads like a shipped one. */
const ACCOUNT_STEPS_COMMENT = ` The account. \`{user}\` and \`{password}\` send this character's own, from
 \`profiles/<id>/profile.yaml\` -- the values are never written here. Every BBS
 words these two prompts differently, which is why they are rows like any
 other rather than something the client recognises on your behalf.`;

/**
 * `view.talkFollowResumeMs` 15s → 45s (todo 10, 2026-09-13).
 *
 * A shipped figure the player has a copy of: leaving it alone would mean the
 * client they run keeps the old hold and the change is invisible to exactly
 * the person who asked for it. **Only where it still says the old default** —
 * a figure somebody has tuned is their answer, and a migration that overwrote
 * it would be the client arguing with them.
 */
function theTalkHoldGrew(home: Home, note: (message: string) => void): void {
  let changed = false;
  edit(home.internal, (document) => {
    const view = document.getIn(['tuning', 'view'], true);
    if (!isMap(view)) return false;
    const held = view.get('talkFollowResumeMs', true);
    if (!isScalar(held) || Number(held.value) !== 15_000) return false;
    held.value = DEFAULT_INTERNAL.tuning.view.talkFollowResumeMs;
    changed = true;
    return true;
  });
  if (changed) note(t('notices.migration.talkHold', { file: home.internal }));
}

/**
 * The two desktop-notification switches become the rows' own (2026-09-13).
 *
 * `ui.alerts.desktop` was `enabled` — raise anything at all — and
 * `whileFocused` — raise it while the window is in front. Every row already
 * carries both questions: `notify` says whether the row raises one, and its
 * own `whileFocused` says whether that holds while somebody is looking. Two
 * vocabularies for one question is how somebody sets one and wonders why the
 * other still decides, which is the ruling the severity floor and the mute
 * lists went under.
 *
 * What the player stated is carried rather than dropped:
 *
 * - `enabled: false` meant *raise nothing*, and it outranked every row. So
 *   every row here has `notify` turned off — the same silence, said where it
 *   can now be undone one row at a time.
 * - `whileFocused: true` meant *even while I am looking*, for everything it
 *   raised. So every row that notifies gains it.
 *
 * The defaults state nothing: a file saying `enabled: true, whileFocused:
 * false` is the shipped answer, and rewriting rows to say it again would put
 * the migration's opinion into a list the player owns.
 *
 * Idempotent — it runs only where the `desktop` key is still there, and it
 * removes it.
 */
function theDesktopSwitchesBecameRows(home: Home, note: (message: string) => void): void {
  const files = [home.options, ...directories(home.profilesDir).map((id) => home.profile(id).file)];
  const changed: string[] = [];
  const silenced: string[] = [];

  for (const file of files) {
    edit(file, (document) => {
      const alerts = document.getIn(['ui', 'alerts'], true);
      if (!isMap(alerts)) return false;
      const desktop = alerts.get('desktop', true);
      if (!isMap(desktop)) {
        // A bare `desktop:` with no map under it still goes; it says nothing
        // and would be read by nothing.
        if (!alerts.has('desktop')) return false;
        alerts.delete('desktop');
        changed.push(file);
        return true;
      }

      // Absent reads as the shipped answer, which is what the client did.
      const raised = desktop.get('enabled') !== false;
      const inFront = desktop.get('whileFocused') === true;
      const rules = alerts.get('rules', true);

      if (isSeq(rules)) {
        for (const item of rules.items) {
          if (!isMap(item)) continue;
          if (!raised) {
            if (item.get('notify') === true) item.set('notify', false);
            // Meaningless without the one above, so it goes with it rather
            // than being left standing on a row that no longer notifies.
            if (item.get('whileFocused') === true) item.set('whileFocused', false);
          } else if (inFront && item.get('notify') === true) {
            item.set('whileFocused', true);
          }
        }
      }

      alerts.delete('desktop');
      changed.push(file);
      if (!raised) silenced.push(file);
      return true;
    });
  }

  if (changed.length === 0) return;
  note(
    t('notices.migration.desktopSwitchesBecameRows', {
      count: changed.length,
      fileList: changed.join(', ')
    })
  );
  if (silenced.length > 0) {
    // Said by name: notifications were switched off wholesale and are now off
    // row by row, which is a thing somebody may want to put back.
    note(
      t('notices.migration.desktopSwitchesSilenced', {
        count: silenced.length,
        fileList: silenced.join(', ')
      })
    );
  }
}

/**
 * `automation.train` into an options file that predates it, off and wanting
 * nothing (todo 10, 2026-09-12). The whole block, in the options file alone,
 * as `drop` and `banking` were: a profile inherits it. After `movement:`
 * where the file has one, as the template orders them.
 */
/**
 * `combat.minHealth` is gone: there is no health floor on *opening* a fight.
 *
 * The goal of the game is survival, and a character that will not swing at
 * what is swinging at it is not safer for the refusal — it is a character
 * losing a fight it is in anyway (todo 13). Low health is the retreat's
 * business and the rest's, and both act on the character rather than on the
 * decision to engage. Measured: a 75% floor on a character rarely above 75%
 * declined 80 of 86 rooms with a monster in them, and the experience rate went
 * to nothing while the character walked laps past what it would not touch.
 *
 * Nothing on disk changes behaviour by this: the key shipped at 0, which was
 * already off. What goes is the option, so a file stating it is not left
 * naming a setting the client no longer reads.
 */
function theCombatFloorWent(home: Home, note: (message: string) => void): void {
  const files = [home.options, ...directories(home.profilesDir).map((id) => home.profile(id).file)];
  const cleaned: string[] = [];

  for (const file of files) {
    edit(file, (document) => {
      const combat = document.getIn(['automation', 'combat'], true);
      if (!isMap(combat)) return false;
      if (!combat.has('minHealth')) return false;
      combat.delete('minHealth');
      // An emptied block reads as a setting somebody meant to fill in, the
      // same reason `dropDiagnosticsPreference` deletes `ui` when it empties.
      if (combat.items.length === 0) document.deleteIn(['automation', 'combat']);
      cleaned.push(file);
      return true;
    });
  }

  if (cleaned.length === 0) return;
  const params = { count: cleaned.length, fileList: cleaned.join(', ') };
  note(
    cleaned.length === 1
      ? t('notices.migration.combatFloorDropped.one', params)
      : t('notices.migration.combatFloorDropped.many', params)
  );
}

/**
 * `combat.maxFightCost` off the files that state it (2026-09-21).
 *
 * The one preference the verdict left to the player, removed at the player's
 * own ask: a share of current health the expected cost of a fight had to stay
 * under. It shipped at 0 — never refuses — so nothing on disk changes
 * behaviour by this, exactly as `theCombatFloorWent` above. What goes is the
 * option, so no file is left naming a setting nothing reads. The verdict's
 * cost is still drawn on the cards; what it no longer does is decline.
 */
function theFightCostWent(home: Home, note: (message: string) => void): void {
  const files = [home.options, ...directories(home.profilesDir).map((id) => home.profile(id).file)];
  const cleaned: string[] = [];

  for (const file of files) {
    edit(file, (document) => {
      const combat = document.getIn(['automation', 'combat'], true);
      if (!isMap(combat)) return false;
      if (!combat.has('maxFightCost')) return false;
      combat.delete('maxFightCost');
      // An emptied block reads as a setting somebody meant to fill in.
      if (combat.items.length === 0) document.deleteIn(['automation', 'combat']);
      cleaned.push(file);
      return true;
    });
  }

  if (cleaned.length === 0) return;
  const params = { count: cleaned.length, fileList: cleaned.join(', ') };
  note(
    cleaned.length === 1
      ? t('notices.migration.fightCostDropped.one', params)
      : t('notices.migration.fightCostDropped.many', params)
  );
}

function statedTheTraining(home: Home, note: (message: string) => void): void {
  editOptions(home, (document) => {
    const automation = document.get('automation', true);
    if (!isMap(automation) || automation.has('train')) return false;
    const pair = document.createPair('train', {
      ...DEFAULT_CONFIG.automation.train,
      wanted: { ...DEFAULT_CONFIG.automation.train.wanted }
    }) as Pair;
    if (isScalar(pair.key)) pair.key.commentBefore = TRAIN_COMMENT;
    const after = automation.items.findIndex((item) => keyText(item) === 'movement');
    if (after >= 0) automation.items.splice(after + 1, 0, pair);
    else automation.items.push(pair);
    note(t('notices.migration.training', { file: home.options }));
    return true;
  });
}

/**
 * `automation.hunting` into the options file (todo 05, 2026-09-13).
 *
 * The block a switch lives in has to exist in the file the player edits, or
 * the only way to reach it is the settings screen — and the screen writes a
 * block, which then has no paragraph beside it saying what it does. Written
 * after `movement` — beside the other block about where a character goes, and
 * near enough the template's own placement, which puts it after `train` — and
 * only where `automation:` is stated at all: a file with no `automation:` block is one the client has
 * never written and the defaults answer for.
 */
function statedTheHunting(home: Home, note: (message: string) => void): void {
  editOptions(home, (document) => {
    const automation = document.get('automation', true);
    if (!isMap(automation) || automation.has('hunting')) return false;
    const pair = document.createPair('hunting', { ...DEFAULT_CONFIG.automation.hunting }) as Pair;
    if (isScalar(pair.key)) pair.key.commentBefore = HUNTING_COMMENT;
    const after = automation.items.findIndex((item) => keyText(item) === 'movement');
    if (after >= 0) automation.items.splice(after + 1, 0, pair);
    else automation.items.push(pair);
    note(t('notices.migration.hunting', { file: home.options }));
    return true;
  });
}

/** The template's own words, abridged, so the two files read alike. */
const HUNTING_COMMENT = ` Going hunting on its own: where this character should be at all.

 The Hunting card ranks every lair the exits reach from where the character
 stands, prices each against this character's own sheet and the realm's own
 respawn clock, sizes a loop to that clock and fills it from the lairs beside
 it. With \`enabled\` on, a character with nothing else to do -- no lap, no
 route, no errand, nothing swinging at it -- is walked to the best spot within
 reach and set looping round it, and the loop is built from the survey each
 time rather than filed anywhere.

 \`radius\` is how far to look, in steps; 0 is everywhere the exits reach.
 There is no floor here: \`walk.minExpPerHour\` is the rate below which nothing
 is worth walking to, and the survey's own exclusions are the safety.`;

/** The template's own words, abridged, so the two files read alike. */
const TRAIN_COMMENT = ` Spending character points -- the \`train stats\` screen.

 Every level hands out character points, and an unspent one is hit points
 the character never has. With \`stats\` on, the client opens the form at a
 trainer when points are unspent, reads its figures, buys the cheapest
 wanted point first until nothing wanted is affordable, and saves. It never
 types into the name fields and never quits the form; what it bought, what
 was refused and what is left are all said out loud. \`wanted\` is where each
 stat should end up: 0, or a figure at or under the current one, leaves
 that stat alone, so the switch does nothing until a figure is raised.`;

/**
 * `automation.spells.autoChoose` into every file that states `spells:` and
 * predates it, off (todo 09, 2026-09-12): the same gap as every key added
 * inside a block, at the head of the block because it changes what every box
 * under it means.
 */
function statedTheSpellChoice(home: Home, note: (message: string) => void): void {
  const files = [home.options, ...directories(home.profilesDir).map((id) => home.profile(id).file)];
  const stated: string[] = [];

  for (const file of files) {
    edit(file, (document) => {
      const block = document.getIn(['automation', 'spells'], true);
      if (!isMap(block) || block.has('autoChoose')) return false;
      const pair = document.createPair('autoChoose', false) as Pair;
      if (isScalar(pair.key)) pair.key.commentBefore = AUTO_CHOOSE_COMMENT;
      block.items.unshift(pair);
      stated.push(file);
      return true;
    });
  }

  if (stated.length === 0) return;
  const params = { count: stated.length, fileList: stated.join(', ') };
  note(
    stated.length === 1
      ? t('notices.migration.spellChoice.one', params)
      : t('notices.migration.spellChoice.many', params)
  );
}

/**
 * `automation.train.levels` and `trainer` into every file that already states
 * `train:` and predates them (todo 18, 2026-09-12), off and 0.
 *
 * `statedTheTraining` above writes the whole block from `DEFAULT_CONFIG`, so a
 * file that never had one gets both free; this is the other half — the files
 * written between that migration and this one, which have a `train:` block
 * holding only the stat screen's half.
 *
 * At the head of the block, because collecting the level comes first in time:
 * the points `stats` spends are awarded by the level `levels` collects.
 */
function statedTheLevelling(home: Home, note: (message: string) => void): void {
  const files = [home.options, ...directories(home.profilesDir).map((id) => home.profile(id).file)];
  const stated: string[] = [];

  for (const file of files) {
    edit(file, (document) => {
      const block = document.getIn(['automation', 'train'], true);
      if (!isMap(block) || block.has('levels')) return false;
      const trainer = document.createPair('trainer', 0) as Pair;
      block.items.unshift(trainer);
      const levels = document.createPair('levels', false) as Pair;
      if (isScalar(levels.key)) levels.key.commentBefore = LEVELLING_COMMENT;
      block.items.unshift(levels);
      stated.push(file);
      return true;
    });
  }

  if (stated.length === 0) return;
  const params = { count: stated.length, fileList: stated.join(', ') };
  note(
    stated.length === 1
      ? t('notices.migration.levelling.one', params)
      : t('notices.migration.levelling.many', params)
  );
}

/**
 * `ui.alerts.rules` into every file that states `alerts:` and predates it
 * (todo 29, 2026-09-12), with the rows a fresh client ships.
 *
 * At the **head** of the block, because that is the order the client asks in:
 * a row decides before anything else does, and a file whose reading order
 * disagrees with the client's is one somebody reasons about wrongly.
 *
 * **It wrote `[]` for four days, and an empty list has since changed meaning.**
 * While the severity floor and the mute list still stood behind the rows an
 * empty list meant *carry on as before*; with those gone (todo 02) it means
 * *the player deleted every row*, which `normalizeAlerts` honours. So a file
 * carrying the `[]` this very function wrote would have started with **no
 * alerts at all**, silently, against a fresh install's four — and its owner
 * would have just lost the floor as well. Nobody deleted anything: the UI to
 * do so arrived in the same change. So an empty list **left by this migration**
 * is filled in, and a list with anything in it is never touched.
 *
 * Found in review. Pre-v1 there is no legacy to keep, but there is also no
 * excuse for changing a shape and leaving the user's own files behind it.
 */
/**
 * The combat and potion settings todo 00 took out, and the one it renamed.
 *
 * Five keys go from `automation.combat` and four from `automation.health`,
 * and `joinFights` becomes `politeAttacks` **with its meaning flipped**:
 *
 * - `joinFights` → `politeAttacks`, negated. MegaMUD's own name and MegaMUD's
 *   own direction — on means *leave somebody else's monster alone*. A file
 *   saying `joinFights: false` meant exactly that, so it becomes
 *   `politeAttacks: true`, and the behaviour the file asked for is kept.
 * - `whileWalking` goes: a route and a lap now both fight, and the player
 *   turning auto-combat off during one is how that is declined.
 * - `avoidUndead` and `avoidDeathSpell` go: neither earned a switch of its
 *   own, and `avoid` says the same thing by name.
 * - `prefer` goes with the *Attack Priority List* it drew, to make room for
 *   the ranked list todo 01 adds.
 * - `drinkHealingPotionBelow`, `drinkManaPotionBelow`, `healingPotionName`,
 *   `manaPotionName` and `potionVerb` go: `potions` says all of it.
 *
 * **The two named potion slots are carried into `potions` rather than
 * deleted**, where the file gave one a threshold: somebody who wrote
 * `drinkHealingPotionBelow: 0.4` asked for a behaviour, and dropping the key
 * would silently stop it. A 0 threshold asked for nothing and carries
 * nothing. `potionVerb` rides along as each carried row's own verb, which is
 * where a verb lives now.
 *
 * Pre-v1 there is no legacy to keep, but a shape that changes under somebody's
 * file without their file changing with it is a setting that stops working
 * and says nothing.
 */
function theCombatAndPotionSettingsWent(home: Home, note: (message: string) => void): void {
  const files = [home.options, ...directories(home.profilesDir).map((id) => home.profile(id).file)];
  const changed: string[] = [];

  for (const file of files) {
    edit(file, (document) => {
      let touched = false;

      const combat = document.getIn(['automation', 'combat'], true);
      if (isMap(combat)) {
        /*
         * The rename first, and only where the file actually said something:
         * a file that never stated `joinFights` was getting the old default
         * (join), which is the new default (`politeAttacks: false`) — so
         * writing anything would state a setting the player never had.
         */
        if (combat.has('joinFights')) {
          const joined = combat.get('joinFights', true);
          const joins = !(isScalar(joined) && joined.value === false);
          combat.delete('joinFights');
          // Only the non-default is worth stating; the default is inherited.
          if (!joins) combat.set('politeAttacks', true);
          touched = true;
        }
        for (const key of ['whileWalking', 'avoidUndead', 'avoidDeathSpell', 'prefer']) {
          if (!combat.has(key)) continue;
          combat.delete(key);
          touched = true;
        }
        if (combat.items.length === 0) document.deleteIn(['automation', 'combat']);
      }

      const health = document.getIn(['automation', 'health'], true);
      if (isMap(health)) {
        const verbNode = health.get('potionVerb', true);
        const verb = isScalar(verbNode) && verbNode.value === 'use' ? 'use' : 'drink';
        /*
         * Carried in the order they fired, so a file that had both keeps the
         * health potion ahead of the mana one. Appended after whatever the
         * player has already written: their own rows were deliberate and
         * these are a translation of a default-shaped setting.
         */
        const carried: Array<{ name: string; when: string; below: number; verb: string }> = [];
        const carry = (thresholdKey: string, nameKey: string, when: string, fallback: string) => {
          const below = health.get(thresholdKey, true);
          const share = isScalar(below) ? Number(below.value) : 0;
          if (!(share > 0)) return;
          const named = health.get(nameKey, true);
          const name = isScalar(named) ? String(named.value ?? '').trim() : '';
          carried.push({ name: name.length > 0 ? name : fallback, when, below: share, verb });
        };
        carry('drinkHealingPotionBelow', 'healingPotionName', 'hp', 'healing potion');
        carry('drinkManaPotionBelow', 'manaPotionName', 'mana', 'mana potion');

        let dropped = false;
        for (const key of [
          'drinkHealingPotionBelow',
          'drinkManaPotionBelow',
          'healingPotionName',
          'manaPotionName',
          'potionVerb'
        ]) {
          if (!health.has(key)) continue;
          health.delete(key);
          dropped = true;
        }

        if (carried.length > 0) {
          const existing = health.get('potions', true);
          const rows = isSeq(existing) ? [...existing.items] : [];
          for (const row of carried) rows.push(document.createNode(row));
          health.set('potions', document.createNode(rows));
        }
        if (dropped) touched = true;
        if (health.items.length === 0) document.deleteIn(['automation', 'health']);
      }

      if (touched) changed.push(file);
      return touched;
    });
  }

  if (changed.length === 0) return;
  const params = { count: changed.length, fileList: changed.join(', ') };
  note(
    changed.length === 1
      ? t('notices.migration.combatAndPotionSettings.one', params)
      : t('notices.migration.combatAndPotionSettings.many', params)
  );
}

function statedTheAlertRules(home: Home, note: (message: string) => void): void {
  const files = [home.options, ...directories(home.profilesDir).map((id) => home.profile(id).file)];
  const stated: string[] = [];

  for (const file of files) {
    edit(file, (document) => {
      const block = document.getIn(['ui', 'alerts'], true);
      if (!isMap(block)) return false;
      const rules = block.get('rules', true);
      // Anything the player has written is theirs, empty or not -- but an empty
      // sequence is the only thing this could have left, and the only thing
      // there is no way to have meant yet.
      const present = block.has('rules');
      if (present && !(isSeq(rules) && rules.items.length === 0)) return false;

      const rows = DEFAULT_CONFIG.ui.alerts.rules.map((rule) => ({ ...rule }));
      if (present) {
        block.set('rules', document.createNode(rows));
      } else {
        const pair = document.createPair('rules', rows) as Pair;
        if (isScalar(pair.key)) pair.key.commentBefore = ALERT_RULES_COMMENT;
        block.items.unshift(pair);
      }
      stated.push(file);
      return true;
    });
  }

  if (stated.length === 0) return;
  const params = { count: stated.length, fileList: stated.join(', ') };
  note(
    stated.length === 1
      ? t('notices.migration.alertRules.one', params)
      : t('notices.migration.alertRules.many', params)
  );
}

/** The template's own words, abridged, so the two files read alike. */
const ALERT_RULES_COMMENT = ` Your own alerts, tried in order.

 The FIRST row that matches a notice decides it -- whether it is shown, how
 loud, and whether it also raises a desktop notification. This list is the
 only thing that decides: anything no row matches is shown at the level the
 client gave it. \`on\` is one of the eleven channels or one of six conditions:
 \`health\` and \`mana\` (a figure you choose, fired on the crossing),
 \`attacked\` (a person swinging at you), \`item\` and \`player\` (matched by
 \`name\`), \`cash\` (a pile a search turned up, \`value\` in copper). \`level\`
 empty keeps what the client decided. See the template for a worked example.`;

/**
 * `automation.movement.recoverGearTries` and `recoverGearFloor` into every
 * file that already states `recoverGear` (todo 21, 2026-09-12).
 *
 * Beside the switch they bound, and only where the switch is stated: a
 * `movement:` block that never mentioned going back for the kit belongs to
 * somebody who has not turned it on, and two numbers bounding a feature they
 * do not use are two keys for the sake of keys.
 */
function statedTheRecoveryBounds(home: Home, note: (message: string) => void): void {
  const files = [home.options, ...directories(home.profilesDir).map((id) => home.profile(id).file)];
  const stated: string[] = [];

  for (const file of files) {
    edit(file, (document) => {
      const block = document.getIn(['automation', 'movement'], true);
      if (!isMap(block) || block.has('recoverGearTries')) return false;
      if (!block.has('recoverGear')) return false;
      const floor = document.createPair(
        'recoverGearFloor',
        DEFAULT_CONFIG.automation.movement.recoverGearFloor
      ) as Pair;
      block.items.push(floor);
      const tries = document.createPair(
        'recoverGearTries',
        DEFAULT_CONFIG.automation.movement.recoverGearTries
      ) as Pair;
      if (isScalar(tries.key)) tries.key.commentBefore = RECOVERY_BOUNDS_COMMENT;
      block.items.splice(block.items.length - 1, 0, tries);
      stated.push(file);
      return true;
    });
  }

  if (stated.length === 0) return;
  const params = { count: stated.length, fileList: stated.join(', ') };
  note(
    stated.length === 1
      ? t('notices.migration.recoveryBounds.one', params)
      : t('notices.migration.recoveryBounds.many', params)
  );
}

/** The template's own words, abridged, so the two files read alike. */
const RECOVERY_BOUNDS_COMMENT = ` And the bounds on trying again.

 A recovery walks a freshly dead, stripped character back to the room that
 killed it, so where that room is still dangerous the trip is itself a way to
 die -- and each one costs a life. \`recoverGearFloor\` stops once this many
 lives are left; \`recoverGearTries\` is how many journeys in a row may fail to
 reach the kit before it gives up. A journey that gets there clears the run.
 0 disables either.`;

/**
 * `automation.health.potions` into every file that states `health:` and
 * predates it (todo 19, 2026-09-12), empty.
 *
 * Beside the two named potion slots, since it is the rest of the same idea:
 * *use this when that is true*, for anything the two cannot say.
 */
function statedThePotionRules(home: Home, note: (message: string) => void): void {
  const files = [home.options, ...directories(home.profilesDir).map((id) => home.profile(id).file)];
  const stated: string[] = [];

  for (const file of files) {
    edit(file, (document) => {
      const block = document.getIn(['automation', 'health'], true);
      if (!isMap(block) || block.has('potions')) return false;
      /*
       * Only where the block already carries the named potion slots. A
       * `health:` block that states a threshold and nothing about potions is
       * not a file that predates this list — it is one whose owner has never
       * asked for potions at all, and writing an empty list into it would add
       * a key to a file for the sake of it. The template ships the key; this
       * is for the files that already went to the trouble of a potion
       * section.
       */
      if (!block.has('healingPotionName')) return false;
      const pair = document.createPair('potions', []) as Pair;
      if (isScalar(pair.key)) pair.key.commentBefore = POTION_RULES_COMMENT;
      block.items.push(pair);
      stated.push(file);
      return true;
    });
  }

  if (stated.length === 0) return;
  const params = { count: stated.length, fileList: stated.join(', ') };
  note(
    stated.length === 1
      ? t('notices.migration.potionRules.one', params)
      : t('notices.migration.potionRules.many', params)
  );
}

/** The template's own words, abridged, so the two files read alike. */
const POTION_RULES_COMMENT = ` And anything else, with its own condition -- *use this when that is true*.

 Each row is an item name, a \`when\` (hp, mana, poisoned, blind, diseased,
 held), a \`below\` share of maximum for the two that are measured, and
 \`drink\` or \`use\`. Only an item the pack lists is ever asked for, and only a
 condition the wire has stated fires one: unknown is not afflicted. Empty,
 because spending a player's consumables unasked is its own failure.`;

/** The template's own words, abridged, so the two files read alike. */
const LEVELLING_COMMENT = ` Going to collect the level.

 In this game you do not level by earning the experience: you earn it, then
 you walk to a trainer and pay. Until you do, every point past the threshold
 does nothing at all -- no hit points, no skills, no character points. Off,
 because a player banking levels for a reroll exists. \`trainer\` is the
 trainer's own shop row, or 0 for the cheapest that will take this character;
 the settings screen offers only the rooms the realm says will take it.`;

/** The template's own words for the switch, so the two files read alike. */
const AUTO_CHOOSE_COMMENT = ` Auto Choose Best Spell.

 On, the round spell is worked out every round from the spellbook the
 client has read and the realm's own figures, the way a player who knows
 their spells would: a spell the monster resists is not cast (a lightning
 bolt at something that resists lightning is mana thrown away), the
 cheapest spell whose *least* roll would finish what is left of the
 monster is cast when there is one, and otherwise the hardest hitter the
 pool can pay for. The cures below come from the book the same way where
 their boxes are blank. The choice is said out loud each time it changes.
 \`attack\` and \`attackFallback\` are what is cast with this off. Off:
 it spends mana on a reading you did not type.`;

/**
 * `automation.health.restNextDoor` into every file that states `health:` and
 * predates it, **on** (todo 08, 2026-09-12) — the one key written on, because
 * it acts only when resting was going to act, and the other default is the
 * one that sat a character down in a lair twice and killed it. Beside
 * `restTo`, since it is about the same rest.
 */
function statedTheRestNextDoor(home: Home, note: (message: string) => void): void {
  const files = [home.options, ...directories(home.profilesDir).map((id) => home.profile(id).file)];
  const stated: string[] = [];

  for (const file of files) {
    edit(file, (document) => {
      const block = document.getIn(['automation', 'health'], true);
      if (!isMap(block) || block.has('restNextDoor')) return false;
      const pair = document.createPair('restNextDoor', true) as Pair;
      if (isScalar(pair.key)) pair.key.commentBefore = REST_NEXT_DOOR_COMMENT;
      // After the resting figures — the trap floor sits directly after the
      // ceiling and keeps that place — and before the mana and the potions.
      const after = ['restBeforeTraps', 'restTo', 'restBelow']
        .map((key) => block.items.findIndex((item) => keyText(item) === key))
        .find((index) => index !== -1);
      if (after === undefined) block.items.push(pair);
      else block.items.splice(after + 1, 0, pair);
      stated.push(file);
      return true;
    });
  }

  if (stated.length === 0) return;
  const params = { count: stated.length, fileList: stated.join(', ') };
  note(
    stated.length === 1
      ? t('notices.migration.restNextDoor.one', params)
      : t('notices.migration.restNextDoor.many', params)
  );
}

/** The template's own words for the switch, so the two files read alike. */
const REST_NEXT_DOOR_COMMENT = ` Rest next door to a lair rather than in it.

 A lair is dangerous for what it is about to contain. Measured 2026-09-12,
 twice: a character won a fight, sat down at 20% in a room whose clock
 makes three wererats every twenty seconds, and met them at 2%. With this
 on, a rest in a room the realm marks as a lair with a short clock is
 refused there, out loud with the figure; a neighbouring room the realm
 holds no lair in is looked into first (\`l <direction>\`), entered only if
 it is empty, rested in, and stepped back from when nothing else has the
 character. Where no neighbour is safe the rest goes ahead where it is,
 said once. On: it acts only when resting was going to act.`;

/**
 * `automation.movement.recoverGear` into every file that states `movement:`
 * and predates it, off (todo 07, 2026-09-12). The same gap `statedTheLight-
 * AndSupplies` closes for the same block, and off for the reason the template
 * gives: it walks the character back towards whatever killed it.
 */
function statedTheGearRecovery(home: Home, note: (message: string) => void): void {
  const files = [home.options, ...directories(home.profilesDir).map((id) => home.profile(id).file)];
  const stated: string[] = [];

  for (const file of files) {
    edit(file, (document) => {
      const movement = document.getIn(['automation', 'movement'], true);
      if (!isMap(movement) || movement.has('recoverGear')) return false;
      const pair = document.createPair('recoverGear', false) as Pair;
      if (isScalar(pair.key)) pair.key.commentBefore = RECOVER_GEAR_COMMENT;
      movement.items.push(pair);
      stated.push(file);
      return true;
    });
  }

  if (stated.length === 0) return;
  const params = { count: stated.length, fileList: stated.join(', ') };
  note(
    stated.length === 1
      ? t('notices.migration.gearRecovery.one', params)
      : t('notices.migration.gearRecovery.many', params)
  );
}

/** The template's own words for the switch, so the two files read alike. */
const RECOVER_GEAR_COMMENT = ` Go back for the kit after a death.

 A death drops everything where the character stood and wakes it in the
 temple naked; measured 2026-09-12, a level-30 character put back on top
 of its own falchion punched a wererat for 16 and sent no \`get\` all
 session. With this on the client notices the strip (the kit it remembers
 is no longer in the pack, and the armour class reads zero), walks back to
 the room it died in -- holding when hurt, fighting nothing on the way --
 takes what is still lying there and the coins, and puts the kit back on.
 Every refusal is said out loud. Off: it walks the character somewhere
 unasked, towards whatever did the killing.`;

/**
 * `automation.combat.hideForOpener` into every file that states `combat:` and
 * predates it, off.
 *
 * The same gap as `theCoinsCanBeShed` above: a key inside a block the file
 * already states is one `reconcileWithTemplate` never reaches, and a setting
 * absent from the file is one nobody finds. Written directly after `opener`,
 * because it is about the opener and means nothing without one.
 *
 * **Off, always.** It spends a command per fight, and a migration cannot
 * know whether the character is a backstabber.
 */
function statedTheHideForOpener(home: Home, note: (message: string) => void): void {
  const files = [home.options, ...directories(home.profilesDir).map((id) => home.profile(id).file)];
  const stated: string[] = [];

  for (const file of files) {
    edit(file, (document) => {
      const combat = document.getIn(['automation', 'combat'], true);
      if (!isMap(combat) || combat.has('hideForOpener')) return false;

      const pair = document.createPair('hideForOpener', false) as Pair;
      if (isScalar(pair.key)) pair.key.commentBefore = HIDE_FOR_OPENER_COMMENT;
      const at = combat.items.findIndex((item) => keyText(item) === 'opener');
      if (at === -1) combat.items.push(pair);
      else combat.items.splice(at + 1, 0, pair);
      stated.push(file);
      return true;
    });
  }

  if (stated.length === 0) return;
  const params = { count: stated.length, fileList: stated.join(', ') };
  note(
    stated.length === 1
      ? t('notices.migration.hideForOpener.one', params)
      : t('notices.migration.hideForOpener.many', params)
  );
}

/**
 * Alert rows named a channel or a watch; now they name an event (todo 03).
 *
 * `on` was one of eleven buckets this client sorts notices into — `combat`,
 * `room`, `session` — offered to somebody looking for a thing that *happens*.
 * A row saying `combat` meant every monster's blow, every refused spell and
 * this character's own death together, which is why nothing in that picker
 * read as selectable.
 *
 * A channel cannot be carried across as one event, because it was several. So
 * each is carried to **the event a player most likely meant by it**, and the
 * conversion is said out loud with the pairs named, because it is the one
 * migration here that can change what somebody is told about: a row that said
 * `combat` and now says *you die* is narrower than it was.
 *
 * The two named watches keep their meaning exactly (`item` is `item-found`,
 * `player` is `player-seen`), as do `health`, `mana`, `attacked` and `cash`,
 * which were already events in everything but name.
 *
 * Every row also gains `quietSeconds`, at the shipped thirty.
 */
function alertRowsBecameEvents(home: Home, note: (message: string) => void): void {
  const files = [home.options, ...directories(home.profilesDir).map((id) => home.profile(id).file)];
  const changed: string[] = [];
  const widened: string[] = [];

  for (const file of files) {
    edit(file, (document) => {
      const rules = document.getIn(['ui', 'alerts', 'rules'], true);
      if (!isSeq(rules)) return false;
      let touched = false;
      for (const item of rules.items) {
        if (!isMap(item)) continue;
        const on = String(item.get('on') ?? '')
          .trim()
          .toLowerCase();
        const replacement = EVENT_FOR_OLD_ROW[on];
        if (replacement !== undefined && on !== replacement) {
          item.set('on', replacement);
          touched = true;
          if ((NOTICE_CHANNELS as readonly string[]).includes(on))
            widened.push(`${on} → ${replacement}`);
        }
        if (!item.has('quietSeconds')) {
          item.set('quietSeconds', DEFAULT_ALERT_DEBOUNCE_SECONDS);
          touched = true;
        }
      }
      if (!touched) return false;
      changed.push(file);
      return true;
    });
  }

  if (changed.length === 0) return;
  note(
    t('notices.migration.alertRowsBecameEvents', {
      count: changed.length,
      fileList: changed.join(', '),
      // Said out loud and by name: a row that meant a whole channel now means
      // one happening, which is narrower than what the player wrote.
      pairs: [...new Set(widened)].join(', ') || t('notices.migration.alertRowsNoChannels')
    })
  );
}

/**
 * What each old `on` word becomes.
 *
 * The five watches keep their meaning; the eleven channels each go to the
 * event a player writing that word most likely wanted. `vitals` is the odd one
 * — it was the client's own crossings rather than a figure the player chose —
 * so it goes to `vitals-crossing`, which is exactly what it produced.
 */
const EVENT_FOR_OLD_ROW: Record<string, AlertRule['on']> = {
  /* The watches, renamed only where the word was not already the event. */
  health: 'health',
  mana: 'mana',
  attacked: 'attacked',
  item: 'item-found',
  player: 'player-seen',
  cash: 'cash-found',
  /* The channels, each to the happening it most often carried. */
  combat: 'died',
  vitals: 'vitals-crossing',
  room: 'player-arrives',
  realm: 'hostile-in-realm',
  party: 'party-hurt',
  command: 'command-refused',
  movement: 'arrived',
  items: 'item-found',
  stealth: 'hide-failed',
  presence: 'movement-heard',
  session: 'connection-lost'
};

/**
 * `combat.avoid` and `combat.mobPriority` became one `combat.mobRules` list
 * (2026-09-21, todo 104).
 *
 * Leaving a monster alone and saying where it comes in the attack order were
 * two lists that merged by different rules — the ranking per monster across
 * global, realm and character, the refusal replaced wholesale per scope — so a
 * character that wanted the realm's refusals plus one of its own had to
 * restate the realm's and keep the copy in step by hand. One row per monster
 * now, `treat: never` being the refusal the flat list used to be.
 *
 * Rebuilt from the values, as `theRewritesBecameAList` is: every `avoid` name
 * becomes a `never` row and every `mobPriority` row keeps its band, the `avoid`
 * rows going **first** because `normalizeMobRules` keeps the first row for a
 * monster and a monster named by both lists was one the player had said to
 * leave alone. The paragraph above the key becomes the template's new one: the
 * old one described five bands and a second list that no longer exists.
 *
 * The realm's own list is a top-level `mobPriority` in `servers/<id>/server.yaml`
 * and is renamed there too — a realm states no `avoid`, so that half is a key
 * rename and nothing else.
 */
function theMobListsBecameRules(home: Home, note: (message: string) => void): void {
  const changed: string[] = [];

  const rowsFrom = (node: unknown): Array<{ mob: string; treat: string }> => {
    if (!isSeq(node)) return [];
    const rows: Array<{ mob: string; treat: string }> = [];
    for (const item of (node as YAMLSeq).items) {
      if (!isMap(item)) continue;
      const mob = (item as YAMLMap).get('mob', false);
      const band = (item as YAMLMap).get('priority', false);
      if (typeof mob !== 'string' || mob.trim().length === 0) continue;
      rows.push({ mob, treat: typeof band === 'string' && band.length > 0 ? band : 'default' });
    }
    return rows;
  };

  const namesFrom = (node: unknown): string[] => {
    if (!isSeq(node)) return [];
    return (node as YAMLSeq).items
      .filter((item) => isScalar(item) && typeof item.value === 'string')
      .map((item) => String((item as Scalar).value))
      .filter((name) => name.trim().length > 0);
  };

  // The options file and every character's: `automation.combat`.
  const files = [home.options, ...directories(home.profilesDir).map((id) => home.profile(id).file)];
  for (const file of files) {
    edit(file, (document) => {
      const combat = document.getIn(['automation', 'combat'], true);
      if (!isMap(combat)) return false;
      const hasAvoid = combat.has('avoid');
      const hasPriority = combat.has('mobPriority');
      if (!hasAvoid && !hasPriority) return false;

      const rows = [
        ...namesFrom(combat.get('avoid', true)).map((mob) => ({ mob, treat: 'never' })),
        ...rowsFrom(combat.get('mobPriority', true))
      ];

      /*
       * Where the *first* of the two keys sat, so the list does not move to
       * the end of the block. Read before the deletes and taken from the first
       * rather than either: everything ahead of it keeps its index whichever
       * of the two go, which an index read off the second would not. The
       * player's own paragraph is deliberately not kept — the one that was
       * there described two lists and five bands.
       */
      const at = combat.items.findIndex(
        (item) => keyText(item) === (hasAvoid ? 'avoid' : 'mobPriority')
      );
      if (hasAvoid) combat.delete('avoid');
      if (hasPriority) combat.delete('mobPriority');
      const pair = document.createPair('mobRules', rows) as Pair;
      if (isScalar(pair.key)) pair.key.commentBefore = MOB_RULES_COMMENT;
      if (at === -1) combat.items.push(pair);
      else combat.items.splice(Math.min(at, combat.items.length), 0, pair);
      changed.push(file);
      return true;
    });
  }

  // And each realm's own list, which is top-level and has no `avoid` half.
  for (const id of directories(home.serversDir)) {
    const file = home.server(id).file;
    edit(file, (document) => {
      if (!document.hasIn(['mobPriority'])) return false;
      const rows = rowsFrom(document.getIn(['mobPriority'], true));
      document.deleteIn(['mobPriority']);
      if (rows.length > 0) document.setIn(['mobRules'], rows);
      changed.push(file);
      return true;
    });
  }

  if (changed.length === 0) return;
  const params = { count: changed.length, fileList: changed.join(', ') };
  note(
    changed.length === 1
      ? t('notices.migration.mobRulesFolded.one', params)
      : t('notices.migration.mobRulesFolded.many', params)
  );
}

/**
 * `combat.mobRules` into a file that predates it, empty (todo 01, 104).
 *
 * An empty list is exactly what the client does without the key, so nothing on
 * disk changes behaviour by this. It is written anyway for the reason every
 * `stated*` migration here is: a setting absent from the file is a setting
 * nobody editing the file can find, and a key added *inside* an existing block
 * is not something `reconcileWithTemplate` will ever bring — it copies whole
 * top-level blocks and never reaches inside one.
 *
 * The options file and every character's, as `hideForOpener` did. The realm's
 * own list lives in `servers/<id>/server.yaml` and is not written here: an
 * absent key there already means *this realm ranks nothing*, and a realm file
 * is short enough to read whole.
 */
function statedTheMobRules(home: Home, note: (message: string) => void): void {
  const files = [home.options, ...directories(home.profilesDir).map((id) => home.profile(id).file)];
  const stated: string[] = [];

  for (const file of files) {
    edit(file, (document) => {
      const combat = document.getIn(['automation', 'combat'], true);
      if (!isMap(combat) || combat.has('mobRules')) return false;

      const pair = document.createPair('mobRules', []) as Pair;
      if (isScalar(pair.key)) pair.key.commentBefore = MOB_RULES_COMMENT;
      // Where the template puts it: after the refusals it belongs with, so the
      // two files read in the same order.
      const at = combat.items.findIndex((item) => keyText(item) === 'refreshRounds');
      if (at === -1) combat.items.push(pair);
      else combat.items.splice(at + 1, 0, pair);
      stated.push(file);
      return true;
    });
  }

  if (stated.length === 0) return;
  const params = { count: stated.length, fileList: stated.join(', ') };
  note(
    stated.length === 1
      ? t('notices.migration.mobRules.one', params)
      : t('notices.migration.mobRules.many', params)
  );
}

/** The template's own words for the list, so the two files read alike. */
const MOB_RULES_COMMENT = ` How named monsters are treated -- MegaMUD's Attack Priority List and its
 avoid list, as one row per monster.

 Six treatments: never, first, high, default, low, last. \`never\` is the
 refusal -- that monster is not attacked automatically at all -- and the
 other five are the order the rest are attacked in. A monster no row names
 is \`default\`, so this is somewhere to add the one that matters rather
 than a ranking of the realm.

   mobRules:
     - { mob: town guard, treat: never }
     - { mob: gnoll shaman, treat: first }
     - { mob: giant rat, treat: last }

 Where a banded monster is in the room the band decides outright and the
 client's own weighing is skipped -- which is the point: a ranking the
 realm's arithmetic could overturn is one nobody can predict from reading
 it. \`never\` and every other refusal still apply first, so a band says
 which of the monsters worth attacking to attack, never that one is.

 A realm may state its own list in \`servers/<id>/server.yaml\`, and it is
 merged rather than replaced: a row here wins for the monster it names,
 and the realm's rows for every other monster still apply.`;

/** The template's own words for the switch, so the two files read alike. */
const HIDE_FOR_OPENER_COMMENT = ` Get back into the shadows between fights, so \`bs\` lands again.

 The realm grants a backstab through \`sn\` and \`hide\` alone, both refused
 while a monster is in the room, and the first blow spends it. A character
 standing in a lair therefore opens every fight after the first in plain
 sight -- measured 2026-09-12 as a 156-damage opener thrown away for a
 38-damage swing, every fight. With this on the client sends \`hide\` when
 the character is seen in an empty room standing still, and \`sn\` when a
 lap or a route has it. Only for an opener that is \`bs\`; a jumpkick has
 nothing to hide for. Off, because it spends a command per fight.`;

/**
 * `automation.loot.discardKinds` into every file that predates it, empty.
 *
 * A key inside a block the file already states is one `reconcileWithTemplate`
 * never reaches, and a setting nobody's file names is a setting nobody finds —
 * `coinKinds` needed exactly this treatment a fortnight ago. Written directly
 * after it, because the two are one decision read together and a file whose
 * *collect* and *discard* lists were pages apart would hide the rule that they
 * are exclusive.
 *
 * **Empty, always.** The list is the one setting in the client that throws
 * something away, and a migration that guessed at it would be spending the
 * player's money on a reading of a file that says nothing.
 */
function theCoinsCanBeShed(home: Home, note: (message: string) => void): void {
  const files = [home.options, ...directories(home.profilesDir).map((id) => home.profile(id).file)];
  const stated: string[] = [];

  for (const file of files) {
    edit(file, (document) => {
      const loot = document.getIn(['automation', 'loot'], true);
      if (!isMap(loot) || loot.has('discardKinds')) return false;

      const pair = document.createPair('discardKinds', []) as Pair;
      if (isScalar(pair.key)) pair.key.commentBefore = LOOT_DISCARD_COMMENT;
      // Directly after the list it is exclusive with, wherever that sits; at
      // the end for a file that never stated one.
      const at = loot.items.findIndex((item) => keyText(item) === 'coinKinds');
      if (at === -1) loot.items.push(pair);
      else loot.items.splice(at + 1, 0, pair);
      stated.push(file);
      return true;
    });
  }

  if (stated.length === 0) return;
  const params = { count: stated.length, fileList: stated.join(', ') };
  note(
    stated.length === 1
      ? t('notices.migration.coinsCanBeShed.one', params)
      : t('notices.migration.coinsCanBeShed.many', params)
  );
}

/** The template's own words for the list, so the two files read alike. */
const LOOT_DISCARD_COMMENT = ` Which coins to put back on the floor whenever any are carried.

 The other end of \`coinKinds\`, and the two are exclusive: a coin on both lists
 would be picked up and dropped for ever, one command each way. A coin on
 neither is kept -- that is the third answer the pair exists to express, and it
 is what makes "stop collecting copper" different from "throw the copper away".

 Empty here, and nothing shipped ever throws money away. A coin is only ever
 dropped when the pack listing says how many are carried, in one
 \`drop <count> <coin>\`, and never while an item in the pack answers to the same
 word -- \`drop 15 copper\` would drop a copper ring instead, which is the
 server's own matching rule and not a guess about it.`;

/**
 * `where-room` wherever `where` is granted — the same question, better worded.
 *
 * `@where-room` is `@where` with the ambiguity taken out: it answers with the
 * realm's own address for the room rather than its name, and which of the two
 * goes out is the **asker's** choice, made from whether this client believes
 * the answerer runs it (`Remotes.ask`). So somebody who granted `where` and
 * then saw the question refused would be refused for a wording they never
 * chose and cannot see, which is the shape a permission must not have.
 *
 * `comeback-room` is deliberately **not** carried anywhere by this. It walks
 * this character across the realm on somebody else's word — more authority
 * than any grant in the table has ever carried — and nothing on disk can imply
 * a decision nobody has made.
 *
 * Every list: the gang's, the party's, and each player's `allow`. A `deny` is
 * left exactly as it is, for the same reason: adding a name to one would be
 * refusing something nobody refused.
 */
function theRoomRemoteFollowsWhere(home: Home, note: (message: string) => void): void {
  let added = 0;
  editOptions(home, (document) => {
    const remotes = document.getIn(['automation', 'remotes'], true);
    if (!isMap(remotes)) return false;

    let changed = false;
    const follow = (node: unknown): void => {
      if (!isSeq(node)) return;
      const words = node.items.map((item) => (isScalar(item) ? String(item.value).trim() : ''));
      const spelling = words.find((word) => word.replace(/^@/, '').toLowerCase() === 'where');
      if (spelling === undefined) return;
      if (words.some((word) => word.replace(/^@/, '').toLowerCase() === 'where-room')) return;
      // Their own spelling: a file that writes `@where` keeps its `@`.
      node.items.push(document.createNode(spelling.startsWith('@') ? '@where-room' : 'where-room'));
      changed = true;
      added += 1;
    };

    follow(remotes.get('gang', true));
    follow(remotes.get('party', true));
    const players = remotes.get('players', true);
    if (isMap(players)) {
      for (const item of players.items) {
        const grant = item.value;
        if (isMap(grant)) follow(grant.get('allow', true));
      }
    }
    return changed;
  });

  if (added > 0) {
    note(t('notices.migration.roomRemoteFollowsWhere', { file: home.options, count: added }));
  }
}

/**
 * `automation.statline` into every options file that predates it, off.
 *
 * Same gap as `statedTheDarkConsole`: a key inside a block the file already
 * states is one `reconcileWithTemplate` never reaches, and a switch nobody's
 * file names is a switch nobody finds. Written where the template puts it,
 * after `onPartyChange`, with the template's own paragraph.
 */
function statedTheStatusLine(
  home: Home,
  note: (message: string) => void,
  template: string | undefined
): void {
  const comments = templateComments(template, 'automation');
  const uiComments = templateComments(template, 'ui');
  let stated = false;

  edit(home.options, (document) => {
    let changed = false;
    const automation = document.getIn(['automation'], true);
    if (isMap(automation) && !automation.has('statline')) {
      const block = document.createNode({ control: DEFAULT_CONFIG.automation.statline.control });
      const pair = document.createPair('statline', block) as Pair;
      const lead = comments.get('automation.statline');
      if (typeof lead === 'string' && isScalar(pair.key)) pair.key.commentBefore = lead;

      const at = automation.items.findIndex((item) => keyText(item) === 'onPartyChange');
      if (at === -1) automation.items.push(pair);
      else automation.items.splice(at + 1, 0, pair);
      changed = true;
    }

    // And the line the player may design, beside the alerts it keeps company
    // with in the template: the presentation half of the same feature. Since
    // todo 99 it is one of the console's rewrites, so the whole block goes in;
    // a file that states the older `ui.statline` is moved by `theLineBecameARewrite`.
    const ui = document.getIn(['ui'], true);
    if (isMap(ui) && !ui.has('rewrites') && !ui.has('statline')) {
      const block = document.createNode(structuredClone(DEFAULT_CONFIG.ui.rewrites));
      const pair = document.createPair('rewrites', block) as Pair;
      const lead = uiComments.get('ui.rewrites');
      if (typeof lead === 'string' && isScalar(pair.key)) pair.key.commentBefore = lead;
      ui.items.push(pair);
      changed = true;
    }

    stated = changed;
    return changed;
  });

  if (!stated) return;
  note(t('notices.migration.statusLineStated', { file: home.options }));
}

/** The shipped design for an entity, by name, since the list is the order. */
function shippedDesign(entity: RewriteEntity): RewriteDesign {
  const found = DEFAULT_REWRITES.find((design) => design.entity === entity);
  if (found === undefined) throw new Error(`no shipped design for ${entity}`);
  return structuredClone(found);
}

/** A design's `template:` as the file will state it: a block scalar where it has lines. */
function designNode(document: Document, design: RewriteDesign): Node {
  const node = document.createNode(design) as YAMLMap<unknown, unknown>;
  const template = node.get('template', true);
  if (isScalar(template) && design.template.includes('\n')) template.type = Scalar.BLOCK_LITERAL;
  return node;
}

/** The `ui.rewrites` block as a node: the bands, then the designs in order. */
function rewritesNode(
  document: Document,
  bands: unknown,
  designs: readonly RewriteDesign[],
  lead: string | undefined
): Pair {
  const block = document.createNode({}) as YAMLMap<unknown, unknown>;
  block.items.push(document.createPair('bands', normalizeBands(bands)) as Pair);
  const list = document.createNode([]) as YAMLSeq<unknown>;
  for (const design of designs) list.items.push(designNode(document, design));
  block.items.push(document.createPair('designs', list) as Pair);
  const pair = document.createPair('rewrites', block) as Pair;
  if (typeof lead === 'string' && isScalar(pair.key)) pair.key.commentBefore = lead;
  return pair;
}

/**
 * `ui.statline` became a design under `ui.rewrites` (2026-09-10, todo 99):
 * the designed status line is one of the listings the console can draw in
 * the realm's place, and the block gathers them as a list.
 *
 * The options file and every character's own, since a design is per
 * character. The layout the player wrote becomes the prompt row's template
 * and their bands the block's; the other designs come from the defaults,
 * off. The player's own paragraph above the old key survives as the block's,
 * else the template's. A file already stating `rewrites:` is left alone.
 */
function theLineBecameARewrite(
  home: Home,
  note: (message: string) => void,
  template: string | undefined
): void {
  const comments = templateComments(template, 'ui');
  const files = [home.options, ...directories(home.profilesDir).map((id) => home.profile(id).file)];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    let moved = false;
    edit(file, (document) => {
      const ui = document.getIn(['ui'], true);
      if (!isMap(ui) || ui.has('rewrites')) return false;
      const at = ui.items.findIndex((item) => keyText(item) === 'statline');
      if (at === -1) return false;
      const old = ui.items[at]!;
      const stated: unknown = isMap(old.value) ? old.value.toJSON() : {};
      const statline = shippedDesign('statline');
      if (isRecord(stated)) {
        if (typeof stated['enabled'] === 'boolean') statline.enabled = stated['enabled'];
        if (typeof stated['layout'] === 'string') statline.template = stated['layout'];
      }
      const designs = DEFAULT_REWRITES.map((design) =>
        design.entity === 'statline' ? statline : structuredClone(design)
      );
      const theirs = isScalar(old.key) ? old.key.commentBefore : undefined;
      const lead = typeof theirs === 'string' ? theirs : comments.get('ui.rewrites');
      const bands = isRecord(stated) ? stated['bands'] : undefined;
      ui.items.splice(at, 1, rewritesNode(document, bands, designs, lead));
      moved = true;
      return true;
    });
    if (moved) note(t('notices.migration.rewritesGathered', { file }));
  }
}

/**
 * How each of the older block's listings was laid out: the list its rows
 * come from, and the one-off lines before and after them, in the order the
 * console drew them.
 */
const OLDER_LISTINGS: Readonly<
  Record<
    Exclude<RewriteEntity, 'statline'>,
    { list: string | null; before: string[]; after: string[] }
  >
> = {
  inventory: { list: 'items', before: [], after: ['keys', 'wealth', 'load'] },
  who: { list: 'players', before: ['head'], after: [] },
  shop: { list: 'items', before: [], after: [] },
  party: { list: 'members', before: [], after: [] },
  experience: { list: null, before: ['line'], after: [] }
};

/**
 * One of the older block's listings — `style`, `header` and a template per
 * line — as one template in the grammar: the rows inside `{for …}`, inside
 * `{table}` where the style was columns, the one-off lines around them. A
 * line stated blank was off and stays out; `{keys}` drew `none` for an empty
 * ring, which the `or` filter now says.
 */
function olderListingTemplate(entity: Exclude<RewriteEntity, 'statline'>, stated: unknown): string {
  const raw = isRecord(stated) ? stated : {};
  const lines = isRecord(raw['lines']) ? raw['lines'] : {};
  const shape = OLDER_LISTINGS[entity];
  const line = (key: string): string | null => {
    const value = lines[key];
    if (typeof value !== 'string' || value.trim().length === 0) return null;
    return key === 'keys' ? value.replace(/\{keys\}/g, '{keys|or:none}') : value;
  };
  const out: string[] = [];
  for (const key of shape.before) {
    const text = line(key);
    if (text !== null) out.push(text);
  }
  const row = shape.list === null ? null : line('row');
  if (shape.list !== null && row !== null) {
    const table = raw['style'] !== 'lines';
    if (table) out.push(raw['header'] === false ? '{table}' : '{table header}');
    out.push(`{for ${shape.list}}`, row, '{/for}');
    if (table) out.push('{/table}');
  }
  for (const key of shape.after) {
    const text = line(key);
    if (text !== null) out.push(text);
  }
  return out.join('\n');
}

/**
 * `ui.rewrites` became a list of designs (2026-09-10, todo 99, second
 * half): a block keyed by kind, each with a template per line, is now
 * `bands` and `designs`, one template each in the one grammar.
 *
 * The options file and every character's own. Each kind the file stated
 * becomes the design of that name, on or off as it was, its lines folded
 * into one template (`olderListingTemplate`); a kind it did not state gets
 * the shipped design, off; the prompt row's bands become the block's. The
 * paragraph above the key is the template's new one, since the old one
 * described keys that no longer exist. A block already stating `designs:`
 * is left alone.
 */
function theRewritesBecameAList(
  home: Home,
  note: (message: string) => void,
  template: string | undefined
): void {
  const comments = templateComments(template, 'ui');
  const files = [home.options, ...directories(home.profilesDir).map((id) => home.profile(id).file)];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    let moved = false;
    edit(file, (document) => {
      const ui = document.getIn(['ui'], true);
      if (!isMap(ui)) return false;
      const at = ui.items.findIndex((item) => keyText(item) === 'rewrites');
      if (at === -1) return false;
      const old = ui.items[at]!;
      if (!isMap(old.value) || old.value.has('designs') || old.value.has('bands')) return false;
      const stated: unknown = old.value.toJSON();
      const block = isRecord(stated) ? stated : {};
      const olderKinds = ['statline', 'inventory', 'who', 'shop', 'party', 'experience'] as const;
      if (!olderKinds.some((kind) => kind in block)) return false;
      const designs = DEFAULT_REWRITES.map((shipped) => {
        const kind = shipped.entity;
        const older = block[kind];
        if (!isRecord(older)) return structuredClone(shipped);
        const design = structuredClone(shipped);
        if (typeof older['enabled'] === 'boolean') design.enabled = older['enabled'];
        if (kind === 'statline') {
          if (typeof older['layout'] === 'string') design.template = older['layout'];
        } else design.template = olderListingTemplate(kind, older);
        return design;
      });
      const statline = block['statline'];
      const bands = isRecord(statline) ? statline['bands'] : undefined;
      ui.items.splice(at, 1, rewritesNode(document, bands, designs, comments.get('ui.rewrites')));
      moved = true;
      return true;
    });
    if (moved) note(t('notices.migration.rewritesListed', { file }));
  }
}

/**
 * `pro` and `set` onto `internal.yaml`'s quiet list, where the list is still
 * the one the client shipped before them.
 *
 * The status-line routine sends both, and thirty lines of profile on every
 * connection is what the quiet list exists to hide. A list cannot say "I
 * removed that" (`pinTheLoopShelf`'s caveat), so this touches only a list
 * that reads exactly `rm, look` — a list somebody has edited, in either
 * direction, is theirs and is left alone.
 */
function quietedTheStatusLineAsks(home: Home, note: (message: string) => void): void {
  let added = false;

  edit(home.internal, (document) => {
    const commands = document.getIn(['terminal', 'quiet', 'commands'], true);
    if (!isSeq(commands)) return false;
    const words = commands.items.map((item) => (isScalar(item) ? String(item.value) : ''));
    if (words.join(' ') !== 'rm look') return false;
    commands.items.push(document.createNode('pro'), document.createNode('set'));
    added = true;
    return true;
  });

  if (!added) return;
  note(t('notices.migration.statusLineAsksQuieted', { file: home.internal }));
}

/**
 * `GMUD (5X)` leaves the disk of anybody the client seeded it onto.
 *
 * It shipped for two days (2026-09-03 to 2026-09-05) as the realm a new
 * character started on, and `theRealmsGainedGmud` — the migration this one
 * replaces — copied it into homes that already had a `servers/` directory. It
 * is gone from `resources/servers/` now, and with it the 2.4 MB GreaterMUD
 * database it named: the default is a Paradigm realm again, which is the realm
 * `resources/world/` was built from, so a new character's realm and its map are
 * one game. What is left behind is the copy on somebody's disk, dialling a
 * third-party address this repository no longer ships and naming a `database:`
 * that has left the package.
 *
 * **It is removed only where there is provably nothing of the player's in it.**
 * Three things have to hold, and any one of them failing leaves the directory
 * exactly as it is:
 *
 * - The file still says `GMUD (5X)` at `70.176.151.219`. A directory somebody
 *   has repurposed carries this client's id and their realm, and the id is the
 *   less important half.
 * - Nothing sits beside `server.yaml` — no `loops/`, no `server.yaml.bak`. A
 *   loop is a fact about the realm and may be the only copy of an evening's
 *   work (`mudengine-config`: a removed server keeps its loops), and a `.bak`
 *   is the settings screen's record that the file was edited.
 * - No character names it. Somebody who made a character there plays there,
 *   with their own credentials, and this is not the code that ends that.
 *
 * **The keeping branch says nothing**, which is the one part worth arguing for.
 * A migration that cannot finish and announces so on every launch is the
 * `findMissingSettings` failure: a complaint that repeats for as long as the
 * file stays as it is. There is nothing to complain about anyway — the realm
 * still works, and its dangling `database:` is already reported at every
 * connection by the fallback that exists for exactly this, deliberately said
 * every time rather than once, because playing against the wrong map is only
 * survivable if you know you are.
 */
function theGmudRealmLeft(home: Home, note: (message: string) => void): void {
  const target = home.server(GMUD_REALM_ID);
  if (!fs.existsSync(target.file)) return;

  let beside: string[];
  try {
    beside = fs.readdirSync(target.dir);
  } catch {
    return;
  }
  if (beside.some((name) => name !== SERVER_FILE)) return;

  try {
    const document = parseDocument(fs.readFileSync(target.file, 'utf8'));
    /*
     * A file that will not parse is not evidence that this is the seeded copy
     * — it is evidence of nothing at all — and deleting a directory on a
     * `catch` is how a migration takes something it was never shown.
     */
    if (document.errors.length > 0) return;
    if (document.getIn(['name']) !== GMUD_REALM_NAME) return;
    if (document.getIn(['host']) !== GMUD_REALM_HOST) return;
  } catch {
    return;
  }

  for (const id of directories(home.profilesDir)) {
    const file = home.profile(id).file;
    if (!fs.existsSync(file)) continue;
    try {
      const document = parseDocument(fs.readFileSync(file, 'utf8'));
      // Same refusal as above, and for the stronger reason: an unreadable
      // character file may be the character that plays on this realm.
      if (document.errors.length > 0) return;
      const named = document.getIn(['server']);
      if (typeof named === 'string' && named.toLowerCase() === GMUD_REALM_NAME.toLowerCase()) {
        return;
      }
    } catch {
      return;
    }
  }

  try {
    fs.rmSync(target.dir, { recursive: true });
  } catch (error) {
    note(
      t('notices.migration.gmudRealmFailed', {
        realm: GMUD_REALM_NAME,
        reason: String(error)
      })
    );
    return;
  }
  note(t('notices.migration.gmudRealmRemoved', { realm: GMUD_REALM_NAME, dir: target.dir }));
}

/**
 * The realm databases were zipped, and a realm file still names the loose one.
 *
 * A 20 MB Access file is 2.4 MB compressed and `RealmSource` reads the archive
 * without unpacking it, so on 2026-09-04 both the database this client ships
 * and the ones this repository builds from became `.zip`s and the loose copies
 * went. A realm file naming one of those by its old name now names a file that
 * is not there — which is the announced fallback to the shipped world, said on
 * every connection, for a rename nobody made on purpose.
 *
 * **Two cases, and only one of them may be assumed.**
 *
 * - A **relative** path can only have come from a file this client ships
 *   (`RealmLibrary.resolve`), so `mdb/gmud20230902.mdb` means the shipped
 *   database and nothing else. It is rewritten on the name alone: the file it
 *   named is gone from the package by definition.
 * - An **absolute** path is the player's own, and is rewritten only on
 *   evidence — the file it names has to be missing *and* the archive has to be
 *   sitting where it was. Anything else is somebody's own layout, and a
 *   migration that edited a path that still resolves would be answering a
 *   question nobody asked.
 *
 * Names are matched whole, against the two that were actually renamed. A rule
 * of the shape *"swap .mdb for .zip"* would rewrite every private realm on the
 * machine into a file that does not exist.
 */
const ZIPPED_DATABASES = new Map<string, string>([
  ['gmud20230902.mdb', '2023-09-02-gmud.zip'],
  ['default-pmud.mdb', '2026-07-26-pmud.zip']
]);

function theDatabasesWereZipped(home: Home, note: (message: string) => void): void {
  const rewritten: string[] = [];

  for (const id of directories(home.serversDir)) {
    edit(home.server(id).file, (document) => {
      const stated = document.getIn(['database']);
      if (typeof stated !== 'string') return false;
      const named = stated.trim();
      if (named.length === 0) return false;

      const archive = ZIPPED_DATABASES.get(path.basename(named));
      if (archive === undefined) return false;

      const zipped = path.join(path.dirname(named), archive);
      if (path.isAbsolute(named) && (fs.existsSync(named) || !fs.existsSync(zipped))) return false;

      document.setIn(['database'], zipped);
      rewritten.push(archive);
      return true;
    });
  }

  if (rewritten.length === 0) return;
  /*
   * The archive's own name, never the path it sits at: these are names this
   * repository ships, while the directory around one is the player's, and
   * `realmOwnsTheDatabase` one screen up refuses to print that for the reason
   * it gives there.
   */
  note(
    rewritten.length === 1
      ? t('notices.migration.databaseZipped.one', { file: rewritten[0] as string })
      : t('notices.migration.databaseZipped.many', { count: rewritten.length })
  );
}

/**
 * The archives this repository keeps became the two worlds the client bundles
 * (2026-09-07), and everything keyed on an archive's name is keyed on the
 * world's.
 *
 * Every archive that ever held one of the two data sets, by the name the
 * repository kept it under: `RealmLore`, `DestinationBook` and `WorldMemory`
 * all key on `WorldMeta.source`, which was the file's own name, and a bundled
 * world is named after itself now — so what was learned against
 * `2026-07-26-pmud.zip` would otherwise sit unread beside a `paradigm` that
 * knows nothing. Names are matched whole, like `ZIPPED_DATABASES`: a rule of
 * the shape *"anything with pmud in it"* would re-file a private realm.
 */
const BUNDLED_ARCHIVES = new Map<string, ShippedWorld>([
  ['default-pmud.mdb', 'paradigm'],
  ['2026-07-26-pmud.zip', 'paradigm'],
  ['pmud.zip', 'paradigm'],
  ['pmud-20260931.mdb', 'paradigm'],
  ['data-paradigm-1.9-test.mdb', 'paradigm'],
  ['data-v1.11p-MME2.0.zip', 'majormud'],
  ['majormud-v1.11p.zip', 'majormud'],
  ['data-v1.11p.mdb', 'majormud']
]);

/** The world an archive's name — raw or already through `realmKey` — stands for. */
function bundledWorldOf(name: string): ShippedWorld | null {
  const key = realmKey(path.basename(name));
  for (const [archive, world] of BUNDLED_ARCHIVES) {
    if (realmKey(archive) === key) return world;
  }
  return null;
}

/**
 * Two things, each on its own evidence:
 *
 * - A realm file naming a bundled archive **relatively** names the world by
 *   its word instead. Relative can only have come from this repository, and
 *   `mdb/` does not ship. An absolute path is the player's own and is left
 *   alone: `RealmLibrary.bundledFor` recognises the archive by its bytes at
 *   every load and says so, which a name cannot.
 * - What was learned against a bundled archive is re-filed under the world:
 *   the monster lore, the slot words and the spell sentences (`mob-lore.json`),
 *   the destinations, and the memory files — a character's, whose `realm`
 *   field is rewritten, and a realm's, whose file is renamed. Where the world
 *   already has a record, the two are merged and the world's own entry wins;
 *   nothing is overwritten and nothing is dropped.
 *
 * Idempotent: run twice, no archive name is left to match.
 */
function theWorldsAreBundled(home: Home, note: (message: string) => void): void {
  const renamed: Array<{ file: string; world: ShippedWorld }> = [];
  for (const id of directories(home.serversDir)) {
    edit(home.server(id).file, (document) => {
      const stated = document.getIn(['database']);
      if (typeof stated !== 'string') return false;
      const named = stated.trim();
      if (named.length === 0 || path.isAbsolute(named)) return false;
      const world = bundledWorldOf(named);
      if (world === null) return false;
      document.setIn(['database'], world);
      renamed.push({ file: path.basename(named), world });
      return true;
    });
  }
  if (renamed.length === 1) {
    const [only] = renamed as [{ file: string; world: ShippedWorld }];
    note(t('notices.migration.worldsNamed.one', { file: only.file, world: only.world }));
  } else if (renamed.length > 1) {
    note(t('notices.migration.worldsNamed.many', { count: renamed.length }));
  }

  const worlds = new Set<ShippedWorld>();
  let moved = 0;
  moved += rekeyLoreFile(home.state('mob-lore.json'), ['realms', 'slots', 'spells'], worlds);
  moved += rekeyLoreFile(home.state('destinations.json'), ['realms'], worlds);
  moved += rekeyMemory(home.state('memory'), worlds);
  if (moved === 0) return;
  const params = { count: moved, worlds: [...worlds].sort().join(', ') };
  note(
    moved === 1
      ? t('notices.migration.loreRekeyed.one', params)
      : t('notices.migration.loreRekeyed.many', params)
  );
}

/**
 * Re-keys the per-realm sections of one JSON file from archive names to world
 * names. A section maps realm key to either a record of entries or a list of
 * rows; a record merges with the world's own entries winning, a list appends
 * what the world's own list does not hold. Returns how many entries moved.
 */
function rekeyLoreFile(file: string, sections: string[], worlds: Set<ShippedWorld>): number {
  if (!fs.existsSync(file)) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // A file that will not parse is left alone: the store suspends itself on
    // it and says so, and this must not be the thing that overwrites it.
    return 0;
  }
  if (typeof parsed !== 'object' || parsed === null) return 0;
  const record = parsed as Record<string, unknown>;

  let moved = 0;
  for (const section of sections) {
    const held = record[section];
    if (typeof held !== 'object' || held === null || Array.isArray(held)) continue;
    const table = held as Record<string, unknown>;
    for (const key of Object.keys(table)) {
      const world = bundledWorldOf(key);
      if (world === null || key === world) continue;
      const from = table[key];
      const into = table[world];
      if (Array.isArray(from)) {
        const kept = Array.isArray(into) ? into : [];
        const seen = new Set(kept.map((row) => JSON.stringify(row)));
        const added = from.filter((row) => !seen.has(JSON.stringify(row)));
        table[world] = [...kept, ...added];
        moved += added.length;
      } else if (typeof from === 'object' && from !== null) {
        const kept =
          typeof into === 'object' && into !== null && !Array.isArray(into)
            ? (into as Record<string, unknown>)
            : {};
        const merged: Record<string, unknown> = { ...kept };
        for (const [name, entry] of Object.entries(from as Record<string, unknown>)) {
          if (name in merged) continue;
          merged[name] = entry;
          moved += 1;
        }
        table[world] = merged;
      } else {
        continue;
      }
      delete table[key];
      worlds.add(world);
    }
  }
  if (moved === 0) return 0;
  try {
    writeJsonAtomically(file, record);
  } catch {
    return 0;
  }
  return moved;
}

/**
 * Re-keys the memory files: a character's carries the realm it was learned
 * against in a field, a realm's carries it in its name as well.
 */
function rekeyMemory(dir: string, worlds: Set<ShippedWorld>): number {
  if (!fs.existsSync(dir)) return 0;
  let moved = 0;
  for (const name of listing(dir)) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const record = parsed as { realm?: unknown; discoveries?: unknown };
    if (typeof record.realm !== 'string' || !Array.isArray(record.discoveries)) continue;
    const world = bundledWorldOf(record.realm);
    if (world === null || record.realm === world) continue;

    const target = name.startsWith('realm-') ? path.join(dir, `realm-${world}.json`) : file;
    let existing: unknown[] = [];
    if (target !== file && fs.existsSync(target)) {
      try {
        const held = JSON.parse(fs.readFileSync(target, 'utf8')) as { discoveries?: unknown };
        if (Array.isArray(held.discoveries)) existing = held.discoveries;
      } catch {
        // The world's own file will not parse: leave both where they are.
        continue;
      }
    }
    const seen = new Set(existing.map(rowKey));
    const added = record.discoveries.filter((entry: unknown) => {
      const key = rowKey(entry);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    try {
      writeJsonAtomically(target, {
        ...record,
        realm: world,
        discoveries: [...existing, ...added]
      });
      if (target !== file) fs.rmSync(file, { force: true });
    } catch {
      continue;
    }
    moved += target === file ? record.discoveries.length : added.length;
    worlds.add(world);
  }
  return moved;
}

/**
 * What makes one memory row the same as another: `discoveryKey` for a row of
 * the store's own shape, the row whole for anything else. A memory file is on
 * the player's disk and a row missing its command must not stop the move.
 */
function rowKey(entry: unknown): string {
  const record = entry as Partial<Discovery> | null;
  return typeof record?.from === 'string' && typeof record.command === 'string'
    ? discoveryKey(record as Discovery)
    : JSON.stringify(entry);
}

/** Temp file and rename, so a crash mid-write cannot leave a half-written record. */
function writeJsonAtomically(file: string, value: unknown): void {
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
}

/**
 * `automation.safety.flee` becomes `automation.safety.retreat`, and the two
 * strategies that named a command become the one that walks.
 *
 * Not a tidy-up. The old block's `strategy: flee` meant *send the word `flee`
 * and let the realm choose the exit*, and there is no such command on this
 * server family — `NOT_COMMANDS` in `src/shared/commands.ts` has the eleven
 * refusals that settled it. `reverse-step` was one attempt at retracing with
 * that same word behind it as the documented fallback, and the fallback was
 * what actually ran, because the walker's history is stale in exactly the
 * situation a retreat is wanted. So both spellings become `step-back`, which is
 * the escape that sends a direction.
 *
 * **Left alone, a file would go on saying `flee:` and the client would go on
 * not reading it** — `normalizeConfig` ignores what it does not know, so the
 * threshold and the switch somebody set would silently revert to the shipped
 * defaults and the escape would be *off*. That is worse than the defect being
 * fixed: a player who had turned running away on would have it turned off by
 * the fix. So the key is renamed **in place**, keeping its value and whatever
 * comment sits above it.
 *
 * `pvp.action: flee` goes with it, and `safeHavenRoom` is untouched: the haven
 * strategy always walked, and it is the one thing in the old block that worked.
 */
function theEscapeIsADirection(
  home: Home,
  note: (message: string) => void,
  template: string | undefined
): void {
  const files = [home.options, ...directories(home.profilesDir).map((id) => home.profile(id).file)];
  const changed: string[] = [];
  const comments = templateComments(template, 'automation');
  const RETIRED_STRATEGIES = new Set(['flee', 'reverse-step']);

  for (const file of files) {
    edit(file, (document) => {
      let touched = false;
      // The prose is refreshed whether or not this file states a safety block:
      // the paragraphs recommending the word by name sit above `pacing:` and
      // `combat:` as well, and a file with none of the settings still carries
      // them. Gated on `safety` existing, a file like that kept its stale
      // documentation with nothing to say so.
      const safety = document.getIn(['automation', 'safety'], true);

      if (isMap(safety)) {
        const index = safety.items.findIndex((item) => keyText(item) === 'flee');
        if (index !== -1) {
          const pair = safety.items[index]!;
          /*
           * A file already carrying both keeps the new one, exactly as
           * `peersBecameRemotes` does: two blocks disagreeing about whether a
           * character runs away is not something to resolve by guessing.
           */
          if (safety.items.some((item) => keyText(item) === 'retreat')) {
            safety.items.splice(index, 1);
          } else {
            (pair.key as Scalar).value = 'retreat';
          }
          touched = true;
        }

        const retreat = safety.get('retreat', true);
        if (isMap(retreat)) {
          const strategy = retreat.get('strategy', true);
          if (isScalar(strategy) && RETIRED_STRATEGIES.has(String(strategy.value))) {
            strategy.value = 'step-back';
            touched = true;
          }
        }

        const pvp = safety.get('pvp', true);
        if (isMap(pvp)) {
          const action = pvp.get('action', true);
          if (isScalar(action) && action.value === 'flee') {
            action.value = 'retreat';
            touched = true;
          }
        }
      }

      /*
       * And the prose, which is the other half of the file the player reads.
       *
       * Earlier migrations wrote paragraphs into their `automation:` block
       * recommending `flee` by name — under `pacing`, under `combat`, under
       * `hangUp` and under `pvp` — and a comment left saying *`flee` is the
       * escape that works* is documentation for a command that does nothing,
       * sitting in the file somebody edits to decide how their character runs
       * away. Refreshed from the shipped template, which is the one statement
       * of what each block does, and only for a comment that actually names
       * the retired word: whatever the player wrote themselves is theirs.
       */
      if (retireStaleProse(document, comments, 'automation')) touched = true;

      if (!touched) return false;
      changed.push(file);
      return true;
    });
  }

  if (changed.length === 0) return;
  const params = { count: changed.length, fileList: changed.join(', ') };
  note(
    changed.length === 1
      ? t('notices.migration.escapeIsADirection.one', params)
      : t('notices.migration.escapeIsADirection.many', params)
  );
}

/**
 * Every comment the shipped template puts above a block under `root:`, one and
 * two levels down, keyed by dotted path.
 *
 * Two levels because that is how deep the templates' own comments go and how
 * deep the stale ones are: `automation.combat`, `automation.safety.hangUp`,
 * `tuning.session.retreatSettleMs`.
 */
function templateComments(template: string | undefined, root: string): Map<string, string> {
  const found = new Map<string, string>();
  const document = templateOf(template);
  if (document === null) return found;
  const block = document.get(root, true);
  if (!isMap(block)) return found;
  for (const pair of block.items) {
    const key = keyText(pair);
    if (key === null) continue;
    const comment = (pair.key as Scalar).commentBefore;
    if (typeof comment === 'string') found.set(`${root}.${key}`, comment);
    if (!isMap(pair.value)) continue;
    for (const [index, inner] of pair.value.items.entries()) {
      const innerKey = keyText(inner);
      if (innerKey === null) continue;
      /*
       * **The first key of a map does not own the comment above it** — `yaml`
       * files that one on the *map*, which is the trap `leadFor` exists for
       * one level up. Read from whichever of the two holds it, or the opening
       * paragraph of every group here is lost on its way into somebody's file.
       */
      const innerComment =
        (inner.key as Scalar).commentBefore ?? (index === 0 ? pair.value.commentBefore : undefined);
      if (typeof innerComment === 'string') {
        found.set(`${root}.${key}.${innerKey}`, innerComment);
      }
    }
  }
  return found;
}

/**
 * Replace any comment under `automation:` that names the retired word with the
 * template's current one for the same key. Returns whether anything moved.
 *
 * A comment the template has nothing to say about is **left alone** rather than
 * blanked: an empty paragraph where an explanation used to be is worse than a
 * stale one.
 *
 * **This cannot tell the player's prose from the client's**, and the trade is
 * stated rather than solved: what it replaces is a comment that both names a
 * command the server does not have *and* sits at a key path the shipped
 * template documents, which is what a paragraph this client wrote looks like.
 * A player who wrote their own note at one of those paths and used the word
 * loses it — and the backup beside the file is where it still is.
 */
function retireStaleProse(
  document: Document,
  comments: Map<string, string>,
  root: string
): boolean {
  const automation = document.get(root, true);
  if (!isMap(automation)) return false;
  let moved = false;
  const refresh = (pair: Pair, path: string): void => {
    const key = pair.key as Scalar;
    const current = key.commentBefore;
    if (typeof current !== 'string' || !/\bflee/i.test(current)) return;
    const replacement = comments.get(path);
    if (replacement === undefined || replacement === current) return;
    key.commentBefore = replacement;
    moved = true;
  };
  for (const pair of automation.items) {
    const key = keyText(pair);
    if (key === null) continue;
    refresh(pair, `${root}.${key}`);
    if (!isMap(pair.value)) continue;

    /*
     * A block's leading comment lands on the **map** rather than on the first
     * key inside it when the block's own key carries none — which is exactly
     * the shape the options file is in, so the paragraph recommending `flee`
     * by name above `hangUp:` is not reachable as `hangUp`'s comment at all.
     *
     * Redistributed rather than rewritten: the template's comment for the
     * block goes on the block's key and the template's comment for the first
     * setting inside it goes on that setting, which is where `yaml` would have
     * put them had the file been written from the template in this key order.
     * Only when the template has both — a blob nothing can replace is left as
     * it stands, because half a paragraph is worse than a stale one.
     */
    const blob = pair.value.commentBefore;
    const first = pair.value.items[0];
    const firstKey = first === undefined ? null : keyText(first);
    if (typeof blob === 'string' && /\bflee/i.test(blob) && firstKey !== null) {
      const forBlock = comments.get(`${root}.${key}`);
      const forFirst = comments.get(`${root}.${key}.${firstKey}`);
      if (forBlock !== undefined && forFirst !== undefined) {
        (pair.key as Scalar).commentBefore = forBlock;
        (first!.key as Scalar).commentBefore = forFirst;
        pair.value.commentBefore = null;
        moved = true;
      }
    }

    for (const inner of pair.value.items) {
      const innerKey = keyText(inner);
      if (innerKey !== null) refresh(inner, `${root}.${key}.${innerKey}`);
    }
  }
  return moved;
}

/**
 * `tuning.loop.fledSettleMs` becomes `escapeSettleMs`, in the one file that has
 * it.
 *
 * `internal.yaml` is a file the player hand-edits to experiment, and
 * `internal.test.ts` asserts the shipped template normalises to the constant
 * exactly — so a key left behind under its old name is both a number somebody
 * set and is no longer read, and a template the test will fail on.
 */
function theLoopSettlesAfterAnEscape(
  home: Home,
  note: (message: string) => void,
  template: string | undefined
): void {
  const comments = templateComments(template, 'tuning');
  let changed = false;
  edit(home.internal, (document) => {
    let touched = false;
    const loop = document.getIn(['tuning', 'loop'], true);
    if (isMap(loop)) {
      const index = loop.items.findIndex((item) => keyText(item) === 'fledSettleMs');
      if (index !== -1) {
        const pair = loop.items[index]!;
        if (loop.items.some((item) => keyText(item) === 'escapeSettleMs')) {
          loop.items.splice(index, 1);
        } else {
          (pair.key as Scalar).value = 'escapeSettleMs';
        }
        touched = true;
      }
    }
    /*
     * And the toolbar button, which is the half of this rename that reaches a
     * *user-facing id*.
     *
     * `toolbar.pinned` holds `ToolbarItemId`s, and half of that union is the
     * `AUTOMATION_SWITCHES` names — the shipped template's own comment listed
     * `flee` among them. A pin left under the old name is a button that
     * silently stops being drawn in a file this client tells the player to
     * edit by hand, which is the same class of failure as a setting nothing
     * reads. `pinTheGearButton` is the precedent for touching this list.
     */
    const pins = document.getIn(['toolbar', 'pinned'], true);
    if (isSeq(pins)) {
      for (const item of pins.items) {
        if (isScalar(item) && item.value === 'flee') {
          item.value = 'retreat';
          touched = true;
        }
      }
    }
    // And the two paragraphs in here that still recommended the word, refreshed
    // from the shipped tuning template exactly as the options file's are.
    if (retireStaleProse(document, comments, 'tuning')) touched = true;
    changed ||= touched;
    return touched;
  });
  if (changed) note(t('notices.migration.escapeSettle', { file: home.internal }));
}

/**
 * `loopPauseBelow` / `loopResumeAt` fold into `restBelow` / `restTo`.
 *
 * They were kept apart on the reasoning that pausing a lap and sitting down are
 * different questions — a tank might rest at 70% standing still and only pause
 * the lap at 35%. The hole in that was written down beside it and enforced
 * nowhere: `SessionManager.mayRest` refuses while a loop is marching, so
 * *between the two figures the character is under the floor it is meant to rest
 * at and forbidden to*. The gap was never a band where two settings did
 * different jobs; it was a band where the character walked while hurt and could
 * not sit down, and `logs/2026-09-02_09-58-25_festus.mudcap.jsonl` is a lap
 * spending its whole length in it.
 *
 * **The user's own numbers are carried across, not discarded.** A file that set
 * `loopPauseBelow` and left `restBelow` alone chose that figure deliberately,
 * and dropping the key would silently move its lap's floor. So a stated loop
 * figure is written into its rest partner when that partner is absent, and the
 * retired keys go either way. Where both are stated the rest pair wins: it is
 * the one the screen has always drawn under the words *Rest If Below*, and it
 * is the half a person is more likely to have set on purpose.
 *
 * A key left behind would break nothing — `normalizeConfig` ignores what it
 * does not know — but it is `dropStandUpThresholds`' rule again: a value in a
 * file that no screen can edit and no code can read is a setting somebody fills
 * in and then waits to see work. Both figures had a field on the settings
 * screen until this change, so somebody has almost certainly set them.
 */
function restIsOnePair(home: Home, note: (message: string) => void): void {
  const files = [home.options, ...directories(home.profilesDir).map((id) => home.profile(id).file)];
  const folded: string[] = [];
  const pairs = [
    ['loopPauseBelow', 'restBelow'],
    ['loopResumeAt', 'restTo']
  ] as const;

  for (const file of files) {
    edit(file, (document) => {
      const health = document.getIn(['automation', 'health'], true);
      if (!isMap(health)) return false;
      if (!pairs.some(([retired]) => health.has(retired))) return false;

      for (const [retired, keeps] of pairs) {
        if (!health.has(retired)) continue;
        /*
         * Carried only into an absent partner. A file stating both has already
         * said what it wants the rest pair to be, and overwriting that with the
         * loop's figure would change a setting the person can see in order to
         * preserve one they can no longer reach.
         */
        if (!health.has(keeps)) {
          const value = health.get(retired, true);
          if (isScalar(value)) health.set(keeps, value.value);
        }
        health.delete(retired);
      }

      // An emptied block reads as a setting somebody meant to fill in, which is
      // the same reason `liftLoops` takes `automation:` with it when it empties.
      if (health.items.length === 0) document.deleteIn(['automation', 'health']);
      folded.push(file);
      return true;
    });
  }

  if (folded.length === 0) return;
  const params = { count: folded.length, fileList: folded.join(', ') };
  note(
    folded.length === 1
      ? t('notices.migration.restOnePair.one', params)
      : t('notices.migration.restOnePair.many', params)
  );
}

/**
 * `automation.combat.rounds` goes, with the idea that it described anything.
 *
 * It said *send one of these verbs every round while a fight runs*, for "the
 * classes that have to ask for their attack each round". No such class exists.
 * `captures/032` is a mystic opening on a night hag with one `bs ha` and then
 * jumpkicking it for 94 lines with nothing else typed; MegaMUD's own help puts
 * `pu`, `kic` and `ju` in its single **Attack Command** beside `a` and `bash`,
 * and has no per-round list at all. What the setting could actually do was
 * spend one command a round, out of the budget the fight is being fought with,
 * to be answered by nothing.
 *
 * Same shape and the same reasoning as `dropStandUpThresholds`: a key left
 * behind breaks nothing, because `normalizeConfig` ignores what it does not
 * know — but a value in a file that no screen can edit and no code can read is
 * a setting somebody will one day fill in and wait to see work. Written into
 * every file that states the block, and an emptied `combat:` is taken with it.
 *
 * **Before `statedTheEntityPredicates`**, which writes five refusal keys into
 * every file that states `combat:`. Run the other way round, a profile whose
 * whole combat block was the macro would have the block emptied and refilled
 * in the same pass, and would end up stating five settings it never asked for
 * instead of going back to inheriting them.
 */
function dropTheRoundMacro(home: Home, note: (message: string) => void): void {
  const files = [home.options, ...directories(home.profilesDir).map((id) => home.profile(id).file)];
  const cleaned: string[] = [];

  for (const file of files) {
    edit(file, (document) => {
      const combat = document.getIn(['automation', 'combat'], true);
      if (!isMap(combat) || !combat.has('rounds')) return false;
      combat.delete('rounds');
      // An emptied block reads as a setting somebody meant to fill in, which is
      // the same reason `liftLoops` takes `automation:` with it when it empties.
      if (combat.items.length === 0) document.deleteIn(['automation', 'combat']);
      cleaned.push(file);
      return true;
    });
  }

  if (cleaned.length === 0) return;
  const params = { count: cleaned.length, fileList: cleaned.join(', ') };
  note(
    cleaned.length === 1
      ? t('notices.migration.roundMacroDropped.one', params)
      : t('notices.migration.roundMacroDropped.many', params)
  );
}

/**
 * Resting gained a ceiling, because casting turns out to break a rest.
 *
 * `restBelow` says when to sit down and the server keeps a character sitting
 * long past it for free — so that one figure only ever described how a rest
 * *begins*, and the first thing to break one above the floor left the
 * character standing for the whole of the recovery. A cast is one of those
 * things: measured 2026-09-02
 * (`logs/2026-09-02_09-08-19_festus.mudcap.jsonl`), `c swan` answered a
 * `(Resting)` prompt and the flag was gone from every prompt after it, with
 * the character then regenerating 2 HP every 30s instead of every 5s.
 *
 * `restTo` is the `healBelow`/`healTo` pair applied to the other half of the
 * same recovery, and it is written at **0** — the single sit-down this client
 * has always done — so nothing about how it *rests* changes until somebody sets
 * it. What changes is that the file says the setting exists, which is the whole
 * point: `reconcileWithTemplate` never reaches inside `automation:`, so a key
 * added to a stated block reaches nobody who has already run the client.
 *
 * **0 stopped meaning "changes nothing" on 2026-09-02**, when the loop's health
 * pair folded into this one and `restTo` became the figure a held lap resumes
 * at as well. A literal 0 there would be a zero-width hysteresis band — resume
 * at exactly the health it paused at — for every file this has already written,
 * which is every file that states a health block. It is still written at 0,
 * because 0 is the honest statement of what this client does about *resting*
 * and inventing a ceiling nobody asked for would be worse; the loop side
 * answers it instead, in `LoopRunner.resumeAt`, which resumes an uncapped rest
 * a margin above the floor rather than at it.
 *
 * Same grain as `statedTheEntityPredicates`: written wherever the block is
 * already stated, never into a profile that inherits its health settings, and
 * nothing stated is ever overwritten.
 */
function statedTheRestCeiling(home: Home, note: (message: string) => void): void {
  const files = [home.options, ...directories(home.profilesDir).map((id) => home.profile(id).file)];
  const stated: string[] = [];

  for (const file of files) {
    edit(file, (document) => {
      const block = document.getIn(['automation', 'health'], true);
      if (!isMap(block) || block.has('restTo')) return false;
      const pair = document.createPair('restTo', 0) as Pair;
      /*
       * Beside `restBelow` rather than at the end of the block: the two are one
       * pair and a ceiling filed under the potions reads as a third unrelated
       * threshold. Falls back to appending when the file states the ceiling's
       * partner nowhere.
       */
      const at = block.items.findIndex(
        (item) => isScalar(item.key) && String(item.key.value) === 'restBelow'
      );
      if (at === -1) block.items.push(pair);
      else block.items.splice(at + 1, 0, pair);
      if (isScalar(pair.key)) pair.key.commentBefore = REST_TO_COMMENT;
      stated.push(file);
      return true;
    });
  }

  if (stated.length === 0) return;
  const params = { count: stated.length, fileList: stated.join(', ') };
  note(
    stated.length === 1
      ? t('notices.migration.restCeiling.one', params)
      : t('notices.migration.restCeiling.many', params)
  );
}

/**
 * `automation.health.restBeforeTraps` into every file that states `health:`
 * without it, at the shipped figure (2026-09-10, todo 01).
 *
 * `statedTheRestCeiling`'s gap and shape: a key inside a block the file
 * already states is one `reconcileWithTemplate` never reaches, and a setting
 * nobody's file names is one nobody finds. Beside `restTo`, because the three
 * are the one Recover row on the screen; falls back to appending when the
 * file states neither partner.
 */
function statedTheTrapRest(home: Home, note: (message: string) => void): void {
  const files = [home.options, ...directories(home.profilesDir).map((id) => home.profile(id).file)];
  const stated: string[] = [];

  for (const file of files) {
    edit(file, (document) => {
      const block = document.getIn(['automation', 'health'], true);
      if (!isMap(block) || block.has('restBeforeTraps')) return false;
      const pair = document.createPair(
        'restBeforeTraps',
        DEFAULT_CONFIG.automation.health.restBeforeTraps
      ) as Pair;
      const at = block.items.findIndex(
        (item) => isScalar(item.key) && String(item.key.value) === 'restTo'
      );
      if (at === -1) block.items.push(pair);
      else block.items.splice(at + 1, 0, pair);
      if (isScalar(pair.key)) pair.key.commentBefore = REST_BEFORE_TRAPS_COMMENT;
      stated.push(file);
      return true;
    });
  }

  if (stated.length === 0) return;
  const params = { count: stated.length, fileList: stated.join(', ') };
  note(
    stated.length === 1
      ? t('notices.migration.trapRest.one', params)
      : t('notices.migration.trapRest.many', params)
  );
}

/**
 * States `ui.showLogo` in an options file that already has a `ui:` block.
 *
 * The same gap `statedDoorForcing` and `statedTheRestCeiling` cover, one block
 * along: `reconcileWithTemplate` brings a whole absent top-level block across
 * with its comments and **deliberately never reaches inside one**, so a key
 * added to `ui:` afterwards reaches nobody who has already run the client.
 * `normalizeConfig` still defaults it, so the mark is drawn either way — but a
 * setting absent from the file is one nobody reading the file can find, which
 * is the invisible-setting failure this repository keeps writing migrations for.
 *
 * The options file only. `showLogo` is a fact about the client rather than
 * about a character — it is offered on the MudEngine page beside the density
 * and the tab placement — so writing it into every profile would put a
 * per-character override in front of somebody who never asked for one.
 *
 * Beside `showHud`, not appended: the two are the same question asked about two
 * pieces of chrome, and a mark filed under the vitals thresholds reads as a
 * third unrelated setting. Falls back to appending when the file states
 * `showHud` nowhere.
 */
/**
 * `ui.console`, the console's own ground when the chrome's is light.
 *
 * A whole new block *inside* `ui:`, which is precisely what
 * `reconcileWithTemplate` does not reach — it fills in an absent top-level
 * block and deliberately never goes inside one, and `ui:` has been there since
 * before this existed. So a file written before today would have kept a
 * console that turns light with the chrome, with nothing in it naming the
 * setting that decides so.
 *
 * The paragraph comes from the shipped template rather than being restated
 * here, following `theLoopSettlesAfterAnEscape`: the template is the
 * documentation, and a copy by hand is a second copy to keep in step.
 *
 * Idempotent for the reason `statedTheMark` is: a key in a map stays added
 * whatever its value, so somebody who sets `keepDark: false` keeps it.
 */
/**
 * The old alert surface becomes rows (todo 02, 2026-09-12).
 *
 * `ui.alerts` carried a severity floor, a per-channel mute list, a find watch
 * and a per-happening desktop mute beside the player's own rows. Every question
 * those answered is a row — *never tell me about movement* is a row with
 * `alert` off, *tell me when a gold ring is found* is an `item` row — so they
 * were a second vocabulary for one question on another part of the same page,
 * and somebody who set one wondered why the other still decided.
 *
 * What a player actually stated is carried over rather than discarded: a muted
 * channel becomes a row that does not alert, a watched word an `item` row, a
 * cash figure a `cash` row, a muted happening a row that shows but does not
 * notify — because *do not interrupt me outside the window* is not *do not tell
 * me*, and turning it into silence would be this migration deciding something
 * the player did not.
 *
 * **The floor is the one thing that cannot be carried, and it is not pretended
 * to be.** `minimum` hid notices by *level*, and a level is a property of the
 * line rather than of a channel — `combat` carries `info` and `critical` alike
 * — so no set of rows says what it said. A file stating one has the key removed
 * and is told so by name, which is the rule for a setting the client stops
 * honouring: say it out loud rather than leave somebody believing a floor is
 * still holding.
 *
 * Rows are appended after whatever the player already wrote: their own rows
 * were always the more specific statement.
 *
 * Idempotent — it runs only where one of the four keys is still there, and it
 * removes them.
 */
function alertSettingsBecameRows(home: Home, note: (message: string) => void): void {
  const files = [home.options, ...directories(home.profilesDir).map((id) => home.profile(id).file)];
  const converted: string[] = [];
  const floored: string[] = [];

  for (const file of files) {
    edit(file, (document) => {
      const alerts = document.getIn(['ui', 'alerts'], true);
      if (!isMap(alerts)) return false;
      const desktop = alerts.get('desktop', true);
      const finds = alerts.get('finds', true);
      const hadFloor = alerts.has('minimum');
      const hadMute = alerts.has('mute');
      const hadFinds = isMap(finds);
      const hadDesktopMute = isMap(desktop) && desktop.has('mute');
      if (!hadFloor && !hadMute && !hadFinds && !hadDesktopMute) return false;

      /*
       * Typed loosely on purpose: `on` here is a *channel* word, which
       * `AlertRule` no longer accepts. `alertRowsBecameEvents` converts them
       * in the same run -- see `HAPPENING_CHANNEL`.
       */
      type WrittenRow = Omit<AlertRule, 'on' | 'quietSeconds'> & { on: string };
      const rows: WrittenRow[] = [];
      const row = (over: Partial<WrittenRow> & Pick<WrittenRow, 'on'>): WrittenRow => ({
        enabled: true,
        level: null,
        alert: true,
        notify: false,
        whileFocused: false,
        side: 'below',
        value: 0,
        percent: false,
        name: '',
        ...over
      });

      for (const channel of lowerWords(alerts.get('mute', true))) {
        if (!(NOTICE_CHANNELS as readonly string[]).includes(channel)) continue;
        rows.push(row({ on: channel, alert: false }));
      }

      if (hadFinds) {
        for (const name of lowerWords(finds.get('items', true))) {
          rows.push(row({ on: 'item', name, level: 'critical', notify: true }));
        }
        const over = Number(finds.get('cashOverCopper')) || 0;
        if (over > 0) rows.push(row({ on: 'cash', value: over, level: 'critical', notify: true }));
      }

      if (hadDesktopMute) {
        for (const happening of lowerWords(desktop.get('mute', true))) {
          const channel = HAPPENING_CHANNEL[happening];
          if (channel === undefined) continue;
          rows.push(row({ on: channel, notify: false }));
        }
      }

      if (rows.length > 0) {
        const existing = alerts.get('rules', true);
        const kept = isSeq(existing) ? (existing.toJSON() as unknown[]) : [];
        alerts.set('rules', document.createNode([...kept, ...rows]));
      }

      alerts.delete('minimum');
      alerts.delete('mute');
      alerts.delete('finds');
      if (isMap(desktop)) desktop.delete('mute');

      converted.push(file);
      if (hadFloor) floored.push(file);
      return true;
    });
  }

  if (converted.length > 0) {
    note(
      t('notices.migration.alertSurfaceConverted', {
        count: converted.length,
        fileList: converted.join(', ')
      })
    );
  }
  if (floored.length > 0) {
    note(
      t('notices.migration.alertFloorDropped', {
        count: floored.length,
        fileList: floored.join(', ')
      })
    );
  }
}

/**
 * Which channel a desktop happening arrives on, for the mute conversion.
 *
 * Still the *channel* words, and deliberately: this step runs before
 * `alertRowsBecameEvents`, which converts every channel word in the list —
 * including the ones written here — into the events that replaced them
 * (todo 03). Writing events here would mean keeping two tables in step for
 * the sake of one run of the same conversion.
 */
const HAPPENING_CHANNEL: Partial<Record<string, string>> = {
  attacked: 'attacked',
  hurt: 'vitals',
  arrived: 'movement',
  hungup: 'session'
};

/** The strings in a YAML sequence, trimmed and lowercased; anything else dropped. */
function lowerWords(node: unknown): string[] {
  const list = isSeq(node) ? (node.toJSON() as unknown[]) : [];
  if (!Array.isArray(list)) return [];
  return Array.from(
    new Set(
      list
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0)
    )
  );
}

function statedTheDarkConsole(
  home: Home,
  note: (message: string) => void,
  template: string | undefined
): void {
  const comments = templateComments(template, 'ui');
  let stated = false;

  edit(home.options, (document) => {
    const ui = document.getIn(['ui'], true);
    if (!isMap(ui) || ui.has('console')) return false;

    const block = document.createNode({
      palette: DEFAULT_CONFIG.ui.console.palette,
      keepDark: DEFAULT_CONFIG.ui.console.keepDark,
      darkTheme: DEFAULT_CONFIG.ui.console.darkTheme
    });
    const pair = document.createPair('console', block) as Pair;
    const lead = comments.get('ui.console');
    if (typeof lead === 'string' && isScalar(pair.key)) pair.key.commentBefore = lead;

    // Where the template puts it: after the mark, before the paragraph about
    // the diagnostics cards. A file that gains it should read like the shipped
    // template rather than like a patch appended to the end of a block.
    const at = ui.items.findIndex((item) => keyText(item) === 'showLogo');
    if (at === -1) ui.items.push(pair);
    else ui.items.splice(at + 1, 0, pair);
    stated = true;
    return true;
  });

  if (!stated) return;
  note(t('notices.migration.darkConsoleStated', { file: home.options }));
}

/**
 * `ui.console.palette`, which of the seven console palettes the realm's colour
 * codes are painted with (2026-09-08).
 *
 * A key inside `ui.console:`, so `statedTheDarkConsole` has to run first: a
 * file with no console block at all gains one carrying all three keys there,
 * and this then finds `palette` present and does nothing. The two together
 * cover both shapes a file can be in.
 *
 * Written as `theme`, which is what the client does without it, so nothing
 * changes except that the file says the option exists — which is the whole
 * point, a setting absent from the file being one nobody reading it can find.
 */
function statedTheConsolePalette(
  home: Home,
  note: (message: string) => void,
  template: string | undefined
): void {
  const comments = templateComments(template, 'ui');
  let stated = false;

  edit(home.options, (document) => {
    const console_ = document.getIn(['ui', 'console'], true);
    if (!isMap(console_) || console_.has('palette')) return false;

    const pair = document.createPair('palette', DEFAULT_CONFIG.ui.console.palette) as Pair;
    const lead = comments.get('ui.console.palette');
    if (typeof lead === 'string' && isScalar(pair.key)) pair.key.commentBefore = lead;

    // First, as the template has it: it is the key that outranks the other two,
    // and a file should read in the order the settings are decided in.
    console_.items.unshift(pair);
    stated = true;
    return true;
  });

  if (!stated) return;
  note(t('notices.migration.consolePaletteStated', { file: home.options }));
}

function statedTheMark(home: Home, note: (message: string) => void): void {
  let stated = false;
  edit(home.options, (document) => {
    const ui = document.getIn(['ui'], true);
    if (!isMap(ui) || ui.has('showLogo')) return false;
    const pair = document.createPair('showLogo', true) as Pair;
    const at = ui.items.findIndex(
      (item) => isScalar(item.key) && String(item.key.value) === 'showHud'
    );
    if (at === -1) ui.items.push(pair);
    else ui.items.splice(at + 1, 0, pair);
    if (isScalar(pair.key)) pair.key.commentBefore = SHOW_LOGO_COMMENT;
    stated = true;
    return true;
  });

  if (!stated) return;
  note(t('notices.migration.markStated', { file: home.options }));
}

/**
 * Moves what shops turn out to stock out of each character's memory and into
 * the realm's, where it now lives.
 *
 * A shop's stock is a fact about the world, not about whoever walked in — see
 * `SplitMemory`. Left where it is, a character's file keeps rows the running
 * client will never read again (it looks for them in the realm file), so the
 * first character to type `list` in that shop learns it a second time and
 * announces it, which is the complaint this whole change answers.
 *
 * The realm each row belongs to is the one stamped in the file it is leaving,
 * because that is the only statement of what its room numbers mean.
 *
 * These are JSON records the client owns outright, so there is no `parseDocument`
 * and no comment to preserve — but the same rule applies as everywhere else: a
 * file that will not parse is left exactly as it is. It is the only copy of
 * what that character learned, and a migration is not permission to throw it
 * away.
 */
function shopStockBecameTheRealms(home: Home, note: (message: string) => void): void {
  const dir = home.state('memory');
  if (!fs.existsSync(dir)) return;

  let moved = 0;
  const realms = new Set<string>();

  for (const name of fs.readdirSync(dir)) {
    // The realm files are the destination, not a source, and re-reading one
    // would move its rows into itself.
    if (!name.endsWith('.json') || name.startsWith('realm-')) continue;

    const file = path.join(dir, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const record = parsed as { realm?: unknown; discoveries?: unknown };
    if (typeof record.realm !== 'string' || !Array.isArray(record.discoveries)) continue;

    const stock = record.discoveries.filter(
      (entry: unknown) =>
        typeof entry === 'object' &&
        entry !== null &&
        (entry as { reason?: unknown }).reason === 'unknown-stock'
    );
    if (stock.length === 0) continue;

    const target = path.join(dir, `realm-${realmKey(record.realm)}.json`);
    let existing: unknown[] = [];
    if (fs.existsSync(target)) {
      try {
        const held = JSON.parse(fs.readFileSync(target, 'utf8')) as { discoveries?: unknown };
        if (Array.isArray(held.discoveries)) existing = held.discoveries;
      } catch {
        // A realm file that will not parse is left alone rather than
        // overwritten, for the reason above. The character's rows stay where
        // they are so nothing is lost, and the next run tries again.
        continue;
      }
    }

    // De-duplicated on the way in: four characters that each learned the same
    // counter would otherwise write four identical rows into one file, and the
    // store's own `seen` set would drop three of them on the next load anyway.
    const seen = new Set(existing.map((entry) => discoveryKey(entry as Discovery)));
    const added = stock.filter((entry) => {
      const key = discoveryKey(entry as Discovery);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    try {
      fs.writeFileSync(
        target,
        `${JSON.stringify({ version: 1, realm: record.realm, discoveries: [...existing, ...added] }, null, 2)}\n`,
        'utf8'
      );
      fs.writeFileSync(
        file,
        `${JSON.stringify({ ...record, discoveries: record.discoveries.filter((entry: unknown) => (entry as { reason?: unknown }).reason !== 'unknown-stock') }, null, 2)}\n`,
        'utf8'
      );
    } catch {
      // Reported by the count staying at zero rather than by a half-move: the
      // character's file is only rewritten after the realm's has been written.
      continue;
    }
    moved += stock.length;
    realms.add(record.realm);
  }

  if (moved === 0) return;
  const params = { count: moved, realmCount: realms.size };
  note(
    moved === 1
      ? t('notices.migration.shopStockShared.one', params)
      : t('notices.migration.shopStockShared.many', params)
  );
}

/**
 * `world.database` moved off the character and onto the realm it plays on.
 *
 * It was per character because a profile is an overlay and two characters on
 * two realms was the case it existed for. That reasoning was about the *realm*
 * all along: two characters on one realm cannot be walking two different maps,
 * so stating it per character was the same answer written out once each, with
 * as many places for it to drift — and a third character added afterwards
 * silently got the shipped world while the two beside it walked Paradigm.
 *
 * So the key is read off every file that states one and written to the realm
 * that file names, then removed. Three things this will not do, each of them a
 * rule the rest of this module already keeps:
 *
 * - **Nothing is overwritten.** A realm that already states a `database` keeps
 *   it, and the character's copy is dropped rather than fought over.
 * - **The first character to name one wins**, when two on the same realm
 *   disagree. There is no right answer to that — they cannot both have been
 *   walking the right map — and the alternative is refusing to migrate, which
 *   leaves the key in a file nothing reads any more.
 * - **The options file's own `world:` is the fallback**, applied to every realm
 *   still without one: it was the default every character inherited, so
 *   dropping it silently would move somebody's whole client onto a different
 *   map. It goes last, so a character's own statement beats it.
 *
 * Idempotent: run twice, the keys are gone and nothing matches.
 */
function realmOwnsTheDatabase(home: Home, note: (message: string) => void): void {
  const servers = directories(home.serversDir);
  /** Realm name, lower-cased (how a character refers to one) → directory id. */
  const idByName = new Map<string, string>();
  for (const id of servers) {
    const file = home.server(id).file;
    if (!fs.existsSync(file)) continue;
    try {
      const document = parseDocument(fs.readFileSync(file, 'utf8'));
      if (document.errors.length > 0) continue;
      const name = document.getIn(['name']);
      idByName.set(String(typeof name === 'string' ? name : id).toLowerCase(), id);
    } catch {
      // Unreadable here is unreadable everywhere else too; the store that reads
      // it next reports it. Skipping is not losing anything.
    }
  }

  /** Realm id → the database the first character naming it stated. */
  const wanted = new Map<string, string>();
  const cleared: string[] = [];

  for (const id of directories(home.profilesDir)) {
    const file = home.profile(id).file;
    edit(file, (document) => {
      const stated = document.getIn(['world', 'database']);
      const realm = document.getIn(['server']);
      // `world: {}` — an empty block left by an earlier save — is nothing to
      // carry, but it is still a key nothing reads, so it goes with the rest.
      if (!document.hasIn(['world'])) return false;

      if (typeof stated === 'string' && stated.length > 0 && typeof realm === 'string') {
        const target = idByName.get(realm.toLowerCase());
        if (target !== undefined && !wanted.has(target)) wanted.set(target, stated);
      }

      document.deleteIn(['world']);
      cleared.push(file);
      return true;
    });
  }

  // The client-wide default, under everything a character said. Read before the
  // block is removed, and removed whether or not any realm takes it: with
  // `world:` gone from the schema it is a key nothing reads.
  let inherited = '';
  editOptions(home, (document) => {
    const stated = document.getIn(['world', 'database']);
    if (!document.hasIn(['world'])) return false;
    if (typeof stated === 'string') inherited = stated;
    document.deleteIn(['world']);
    cleared.push(home.options);
    return true;
  });

  const written: string[] = [];
  for (const id of servers) {
    const database = wanted.get(id) ?? inherited;
    if (database.length === 0) continue;
    edit(home.server(id).file, (document) => {
      // Already there — a file edited by hand, or a second run of this.
      if (document.hasIn(['database'])) return false;
      if (!isMap(document.contents)) return false;
      const key = new Scalar('database');
      // The paragraph that explains it, because in these files the comments are
      // the documentation and a bare path says nothing about why it is here.
      key.commentBefore = DATABASE_COMMENT;
      document.contents.add(document.createPair(key, database));
      written.push(home.server(id).file);
      return true;
    });
  }

  if (cleared.length === 0 && written.length === 0) return;
  /*
   * Counts, and no paths at all.
   *
   * The other steps name the files they touched, which is right for a move
   * somebody may want to go and look at. This one would be naming a *database
   * path* out of somebody's own file if it went further, and a realm file's
   * path says which characters exist. Counts are enough to tell a migration
   * that ran from one that lost something.
   */
  const params = { realmCount: written.length, characterCount: cleared.length };
  if (written.length === 0) {
    note(t('notices.migration.realmOwnsDatabaseCleared', params));
    return;
  }
  note(
    written.length === 1
      ? t('notices.migration.realmOwnsDatabase.one', params)
      : t('notices.migration.realmOwnsDatabase.many', params)
  );
}

/** Why a realm names a map, put beside the key this migration writes. */
const DATABASE_COMMENT = [
  ' The world file every character playing here walks. Empty or absent is the',
  ' world that ships with the client; a derivative such as Paradigm names its',
  ' own .mdb, .accdb, .sqlite or .db, or a .zip holding one.',
  '',
  ' Moved here out of the characters that stated it: two characters on one',
  ' realm cannot be walking two different maps.'
].join('\n');

/**
 * What forcing a barrier is set to, written into a `movement:` block that was
 * copied before there was any.
 *
 * `reconcileWithTemplate` fills in a whole missing block and deliberately
 * never reaches inside one, so a file that already states `movement:` — which
 * every file copied since the block existed does — would never see these four
 * keys. They default to off either way, and that is exactly the failure this
 * project has a name for: a setting nobody can see in their own file is a
 * setting nobody uses, which is how automatic login shipped complete and
 * looked broken.
 *
 * The values written are the defaults, so nothing about how the client behaves
 * changes. What changes is that the file says so, with the paragraph that
 * explains it — the template *is* the documentation here.
 *
 * Nothing is overwritten: a key already stated is the user's answer, whatever
 * it says.
 */
/**
 * The conversation log's pair stated in the user's own `logging:` block.
 *
 * Same gap as `statedDoorForcing` and for the same reason:
 * `reconcileWithTemplate` never reaches inside a block, and every file copied
 * since `logging:` existed states it — so the two keys added to the shipped
 * block reach nobody who has already run the client. The values are the
 * defaults, so nothing changes; what changes is that the file says so, with
 * the paragraph that explains it. Only the global file: a profile is a sparse
 * overlay and inherits what it does not state.
 */
function keptTheConversationLog(home: Home, note: (message: string) => void): void {
  let stated = false;
  edit(home.options, (document) => {
    const logging = document.getIn(['logging'], true);
    if (!isMap(logging)) return false;

    let changed = false;
    let first: Pair | null = null;
    for (const [key, value] of CONVERSATION_LOG_DEFAULTS) {
      if (logging.has(key)) continue;
      const pair = document.createPair(key, value) as Pair;
      logging.items.push(pair);
      if (first === null) first = pair;
      changed = true;
    }
    if (!changed) return false;
    if (first !== null && isScalar(first.key)) first.key.commentBefore = CONVERSATION_LOG_COMMENT;
    stated = true;
    return true;
  });

  if (stated) note(t('notices.migration.conversationLogKept'));
}

/**
 * `openDoors` and `bashDoors` turned **on**, in the files this client wrote them
 * `false` into (2026-09-07, todo 06).
 *
 * This is the one migration here that changes an answer rather than adding a
 * missing one, and it is only defensible because of where the answer came from:
 * `statedDoorForcing` above wrote these two keys into every options file and
 * every profile *at the shipped default*, which was `false`. Nobody chose it.
 * Flipping the default alone would therefore reach nobody — every existing file
 * says `false` in writing — which is the invisible-setting failure with a
 * migration having caused it.
 *
 * So the value is moved, and **only from `false`**: a file already saying `true`
 * is left alone, so this cannot run twice and cannot undo somebody switching it
 * back on. What it cannot tell is a `false` somebody typed on purpose from the
 * one the client wrote, and that trade is stated rather than solved — it is
 * said out loud, it names every file, and the rolling backup beside each is
 * where the old answer still is.
 *
 * `pickLocks` is deliberately **not** moved: it is the same decision made with
 * a skill this client cannot check the character has.
 */
function theDoorsOpenByDefault(home: Home, note: (message: string) => void): void {
  const files = [home.options, ...directories(home.profilesDir).map((id) => home.profile(id).file)];
  const moved: string[] = [];

  for (const file of files) {
    edit(file, (document) => {
      const movement = document.getIn(['automation', 'movement'], true);
      if (!isMap(movement)) return false;

      let changed = false;
      for (const key of ['openDoors', 'bashDoors']) {
        // `=== false` and not falsy: an absent key inherits the new default
        // already, and writing one in would be this migration stating a
        // setting rather than moving one.
        if (movement.get(key) !== false) continue;
        movement.set(key, true);
        changed = true;
      }
      if (!changed) return false;
      moved.push(file);
      return true;
    });
  }

  if (moved.length === 0) return;
  const params = { count: moved.length, fileList: moved.join(', ') };
  note(
    moved.length === 1
      ? t('notices.migration.doorsOpened.one', params)
      : t('notices.migration.doorsOpened.many', params)
  );
}

/**
 * `hangUp.onlyWhenClean` became `hangUp.penalties` (2026-09-23, todo 01): the
 * question is whether the realm charges for a hang-up, which Paradigm's menu
 * answers itself and a realm's `server.yaml` can answer for everyone there.
 * Every file stated `onlyWhenClean: true`, the shipped default copied whole,
 * so nobody chose it: the options file takes the new default, `penalties:
 * false`, and a profile drops the key to inherit its realm. A profile that
 * said `false` said *hang up anyway*, and keeps that as `penalties: false`.
 */
function theHangPenaltyIsTheRealms(home: Home, note: (message: string) => void): void {
  const files = [home.options, ...directories(home.profilesDir).map((id) => home.profile(id).file)];
  const changed: string[] = [];

  for (const file of files) {
    edit(file, (document) => {
      const hangUp = document.getIn(['automation', 'safety', 'hangUp'], true);
      if (!isMap(hangUp) || !hangUp.has('onlyWhenClean')) return false;
      const saidFalse = hangUp.get('onlyWhenClean') === false;
      hangUp.delete('onlyWhenClean');
      if ((file === home.options || saidFalse) && !hangUp.has('penalties')) {
        const pair = document.createPair('penalties', false) as Pair;
        if (isScalar(pair.key)) pair.key.commentBefore = HANG_PENALTIES_COMMENT;
        hangUp.items.push(pair);
      }
      changed.push(file);
      return true;
    });
  }

  if (changed.length === 0) return;
  const params = { count: changed.length, fileList: changed.join(', ') };
  note(
    changed.length === 1
      ? t('notices.migration.hangPenalties.one', params)
      : t('notices.migration.hangPenalties.many', params)
  );
}

/**
 * `movement.useWards` becomes `health.useWards`, and it is turned **on**
 * (2026-09-22, todo 02).
 *
 * Two changes to one key, and both of them are the same admission: the switch
 * was put in the wrong section and shipped off. It is one day old, and on the
 * world that ships for MajorMUD realms it could not have fired at all in that
 * day — that data writes the desert's gate as `checkspell`, which the
 * converter declined to read as *this spell stops the room* until realm
 * format 45. So there is no file anywhere whose `false` records a player
 * watching this work and turning it off; every one of them is
 * `statedTheNewAutomation` writing the shipped default a day ago.
 *
 * Which is `theDoorsOpenByDefault`'s argument exactly, and the same two
 * narrownesses apply: a stated `true` carries across as `true`, so this cannot
 * undo somebody's own switch, and it is said out loud naming every file, with
 * the rolling backup beside each holding the old answer.
 *
 * The section move is the other half. Every row of `health.potions` is *use
 * this item when that is true*, this is that sentence written by the realm,
 * and the settings screen draws them together under *When to use an item* —
 * so a key under `movement:` would be one the screen shows somewhere its own
 * file does not.
 */
function theWardSwitchMovedToHealth(home: Home, note: (message: string) => void): void {
  const files = [home.options, ...directories(home.profilesDir).map((id) => home.profile(id).file)];
  const moved: string[] = [];

  for (const file of files) {
    edit(file, (document) => {
      const movement = document.getIn(['automation', 'movement'], true);
      if (!isMap(movement) || !movement.has('useWards')) return false;
      // `true` either way, and the two ways are not the same fact: a stated
      // `true` is somebody's own answer travelling across unchanged, and a
      // `false` is this client's own write at the old default being replaced
      // by the new one. See the doc comment for why the second is defensible.
      movement.delete('useWards');
      // An emptied block reads as a setting somebody meant to fill in, the
      // same reason `theCombatFloorWent` deletes one.
      if (movement.items.length === 0) document.deleteIn(['automation', 'movement']);
      const health = document.getIn(['automation', 'health'], true);
      // A file stating no `health:` block gets the key from
      // `statedTheNewAutomation`'s own pass, which runs after this one.
      if (isMap(health)) {
        if (health.has('useWards')) health.set('useWards', true);
        else {
          const pair = document.createPair('useWards', true) as Pair;
          if (isScalar(pair.key)) pair.key.commentBefore = USE_WARDS_COMMENT;
          health.items.push(pair);
        }
      }
      moved.push(file);
      return true;
    });
  }

  if (moved.length === 0) return;
  const params = { count: moved.length, fileList: moved.join(', ') };
  note(
    moved.length === 1
      ? t('notices.migration.wardsMoved.one', params)
      : t('notices.migration.wardsMoved.many', params)
  );
}

function statedDoorForcing(home: Home, note: (message: string) => void): void {
  const files = [home.options, ...directories(home.profilesDir).map((id) => home.profile(id).file)];
  const stated: string[] = [];

  for (const file of files) {
    edit(file, (document) => {
      const movement = document.getIn(['automation', 'movement'], true);
      if (!isMap(movement)) return false;

      let changed = false;
      let first: Pair | null = null;
      for (const [key, value] of DOOR_FORCING_DEFAULTS) {
        if (movement.has(key)) continue;
        const pair = document.createPair(key, value) as Pair;
        movement.items.push(pair);
        if (first === null) first = pair;
        changed = true;
      }
      if (!changed) return false;
      // The paragraph goes on the first key actually added, so a file that
      // already stated `pickLocks` and not `bashDoors` still gets an
      // explanation rather than two bare booleans.
      if (first !== null && isScalar(first.key)) first.key.commentBefore = DOOR_FORCING_COMMENT;
      stated.push(file);
      return true;
    });
  }

  if (stated.length === 0) return;
  const params = { count: stated.length, fileList: stated.join(', ') };
  note(
    stated.length === 1
      ? t('notices.migration.doorForcingStated.one', params)
      : t('notices.migration.doorForcingStated.many', params)
  );
}

/**
 * The gear button added to an existing toolbar row.
 *
 * The same gap `pinTheLoopShelf` closes and for the same reason: `InternalStore`
 * copies its template on first run and never overwrites — right, the file is
 * full of the user's own choices — so a button added to the shipped row
 * afterwards reaches nobody who has already run the client. A control nobody
 * can find is one that was never built, and this one is reached for at the one
 * moment a player is least inclined to go looking through a kebab: standing at
 * a healer with a full pack and nothing on.
 *
 * Added **after `connect`**, where the shipped row puts it, so a migrated
 * client draws the row a fresh one draws. A row curated by hand is still the
 * user's answer: the button goes on at the front rather than nowhere, and
 * nothing else is disturbed.
 *
 * Somebody who deliberately unpins it says so in `localStorage`
 * (`useToolbarPins`), which this cannot and must not reach.
 */
function pinTheGearButton(home: Home, note: (message: string) => void): void {
  let pinned = false;
  edit(home.internal, (document) => {
    const list = document.getIn(['toolbar', 'pinned'], true);
    if (!isSeq(list)) return false;

    const ids = list.items.map((item) => (isScalar(item) ? String(item.value) : null));
    // Already there — a file edited by hand, or a second run of this.
    if (ids.includes('gear:restore')) return false;

    const after = ids.indexOf('connect');
    list.items.splice(after >= 0 ? after + 1 : 0, 0, new Scalar('gear:restore'));
    pinned = true;
    return true;
  });

  if (pinned) note(t('notices.migration.gearButtonPinned'));
}

/**
 * The walk's nudge interval, in the tuning file the player actually owns.
 *
 * `reconcileWithTemplate` only ever adds a whole *absent* top-level block, and
 * every file copied since `tuning:` existed states `walk:` — so a key added
 * inside it reaches nobody who has already run the client. The number still
 * decides something (`TUNING_DEFAULTS` answers underneath), which is the worse
 * half: the behaviour changes and the figure that governs it is invisible in
 * the one file this client says every such figure lives in.
 *
 * Beside `maxHolds`, where the shipped file puts it, so a migrated tuning file
 * reads as a fresh one. Falls back to appending when the block has been
 * rearranged by hand.
 */
/**
 * The Auto-Bless switch onto the toolbar, beside retaliate (todo 04).
 *
 * `pinTheGearButton`'s shape and its caveat: a list entry cannot say it was
 * removed on purpose, so a player who unpins it finds it back next launch,
 * and this says so in place.
 */
function pinTheBlessSwitch(home: Home, note: (message: string) => void): void {
  let pinned = false;
  edit(home.internal, (document) => {
    const list = document.getIn(['toolbar', 'pinned'], true);
    if (!isSeq(list)) return false;
    const ids = list.items.map((item) => (isScalar(item) ? String(item.value) : null));
    if (ids.includes('autoBless')) return false;
    // Beside retaliate as the shipped row has it; on a curated row missing
    // it, after the nearest of the switches that precede it there, else the
    // front — the order a fresh client draws, as far as the row allows.
    const after = ['retaliate', 'combat', 'automation']
      .map((id) => ids.indexOf(id))
      .find((at) => at >= 0);
    list.items.splice(after === undefined ? 0 : after + 1, 0, new Scalar('autoBless'));
    pinned = true;
    return true;
  });
  if (pinned) note(t('notices.migration.blessSwitchPinned'));
}

function statedTheStepNudge(home: Home, note: (message: string) => void): void {
  let stated = false;
  edit(home.internal, (document) => {
    const block = document.getIn(['tuning', 'walk'], true);
    if (!isMap(block) || block.has('nudgeAfterMs')) return false;

    /*
     * The default itself, never a copy of it. `internal.test.ts` binds the
     * shipped template to `TUNING_DEFAULTS`; a literal here would be a third
     * copy that nothing binds, and a stated key outranks the default — so a
     * later change to the figure would write the *stale* one into every
     * existing file and silently keep the old behaviour. Read through
     * `DEFAULT_INTERNAL`, which is that constant, rather than exporting a
     * second door onto it.
     */
    const pair = document.createPair(
      'nudgeAfterMs',
      DEFAULT_INTERNAL.tuning.walk.nudgeAfterMs
    ) as Pair;
    const at = block.items.findIndex(
      (item) => isScalar(item.key) && String(item.key.value) === 'maxHolds'
    );
    if (at === -1) block.items.push(pair);
    else block.items.splice(at + 1, 0, pair);
    if (isScalar(pair.key)) pair.key.commentBefore = NUDGE_AFTER_COMMENT;
    stated = true;
    return true;
  });

  if (stated) note(t('notices.migration.stepNudgeStated'));
}

/**
 * `{action}` becomes `{action.toggleEquip}` in a design the player keeps.
 *
 * What can be done with a thing is a family since todo 14 — the equip gate it
 * already had, and putting the thing down — so `action` went from one glyph to
 * a record of them. A template still naming the record draws **nothing**: it
 * resolves, so there is no error to report, and the glyph simply stops being
 * there. That is the silent kind of breakage this project migrates rather than
 * explains, and the tag is unambiguous, so it is a replacement of exactly that
 * text inside each design's own template and nothing else.
 *
 * Bare row fields are left alone: `{for items}{weight}{/for}` still binds the
 * row's figures bare and always will. Only the name whose *meaning* moved is
 * rewritten.
 */
function theActionsBecameAFamily(home: Home, note: (message: string) => void): void {
  const files = [home.options, ...directories(home.profilesDir).map((id) => home.profile(id).file)];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    let changed = false;
    edit(file, (document) => {
      const designs = document.getIn(['ui', 'rewrites', 'designs'], true);
      if (!isSeq(designs)) return false;
      let touched = false;
      for (const design of designs.items) {
        if (!isMap(design)) continue;
        const template = design.get('template', true);
        if (!isScalar(template) || typeof template.value !== 'string') continue;
        if (!template.value.includes('{action}')) continue;
        template.value = template.value.replaceAll('{action}', '{action.toggleEquip}');
        touched = true;
      }
      changed = touched;
      return touched;
    });
    if (changed) note(t('notices.migration.actionsFamilied', { file }));
  }
}

/**
 * How far a drawn plan may drift before the press asks about the redrawn one.
 *
 * `statedTheStepNudge`'s gap one key along again: a key added inside an
 * existing `walk:` block reaches nobody who has already run the client, and
 * this one decides whether pressing Walk on a plan the character has wandered
 * off the start of walks quietly or puts the new plan back on screen. Without
 * it the file has no figure and the behaviour is invisible in the one place
 * the client tells the player to look for it.
 *
 * Beside `resumeAskSteps`, where the shipped file puts it and where the
 * distance it is not is already explained.
 */
function statedTheReplanDrift(home: Home, note: (message: string) => void): void {
  let stated = false;
  edit(home.internal, (document) => {
    const block = document.getIn(['tuning', 'walk'], true);
    if (!isMap(block) || block.has('replanDriftSteps')) return false;

    // The default itself, never a copy: `statedTheStepNudge` has the argument.
    const pair = document.createPair(
      'replanDriftSteps',
      DEFAULT_INTERNAL.tuning.walk.replanDriftSteps
    ) as Pair;
    const at = block.items.findIndex(
      (item) => isScalar(item.key) && String(item.key.value) === 'resumeAskSteps'
    );
    if (at === -1) block.items.push(pair);
    else block.items.splice(at + 1, 0, pair);
    if (isScalar(pair.key)) pair.key.commentBefore = REPLAN_DRIFT_COMMENT;
    stated = true;
    return true;
  });

  if (stated) note(t('notices.migration.replanDriftStated'));
}

/**
 * How long a walk waits in the dark for the light that fixes it.
 *
 * `statedTheReplanDrift`'s gap, one key along: `reconcileWithTemplate` adds an
 * absent top-level block and never reaches inside one, so a key added under
 * `walk:` reaches nobody who has already run the client.
 *
 * Worth stating rather than leaving to the default, because what it bounds is
 * a walk that used to *stop*: a blinding room prints no room block, the client
 * could not say where the character was standing, and the journey ended one
 * statement before auto-light proposed the torch that fixed it. The figure is
 * the only thing standing between waiting for a light and waiting for ever.
 *
 * Beside `heldFallbackMs`, where the shipped file puts it.
 */
function statedTheLightWait(home: Home, note: (message: string) => void): void {
  let stated = false;
  edit(home.internal, (document) => {
    const block = document.getIn(['tuning', 'walk'], true);
    if (!isMap(block) || block.has('lightWaitMs')) return false;

    // The default itself, never a copy: `statedTheStepNudge` has the argument.
    const pair = document.createPair(
      'lightWaitMs',
      DEFAULT_INTERNAL.tuning.walk.lightWaitMs
    ) as Pair;
    const at = block.items.findIndex(
      (item) => isScalar(item.key) && String(item.key.value) === 'heldFallbackMs'
    );
    if (at === -1) block.items.push(pair);
    else block.items.splice(at + 1, 0, pair);
    if (isScalar(pair.key)) pair.key.commentBefore = LIGHT_WAIT_COMMENT;
    stated = true;
    return true;
  });

  if (stated) note(t('notices.migration.lightWaitStated'));
}

/** The template's own words for the key, so the two files read alike. */
const LIGHT_WAIT_COMMENT = ` How long a walk stands still in a room too dark to read, waiting for the
 light auto-light is readying.

 A blinding room prints no room block at all, so the client cannot say where
 the character is standing and the walk used to stop there -- one statement
 before the torch it needed was even proposed. What it waits for is three
 commands and two answers ("light torch", "You lit the torch.", "l", the room),
 measured at 145ms end to end; what makes this seconds rather than a fifth of
 one is the queue, which paces the light behind whatever else is in flight.

 A deadline and not a retry: there is nothing further to ask. Past it the room
 is dark for a reason no light in the pack fixes, and the walk stops with the
 sentence it always had.`;

/**
 * The window the walk's nudge deadline is measured over.
 *
 * `statedTheStepNudge`'s gap, one key along, and the same argument: a key
 * added inside an existing `walk:` block reaches nobody who has already run
 * the client, and this one changes what `nudgeAfterMs` beside it *means* —
 * from the whole deadline to the margin on top of a measurement. A figure
 * whose meaning moved while the file still explains the old one is worse than
 * one that is merely absent, so the comment goes in with it.
 *
 * Beside `nudgeAfterMs`, where the shipped file puts it.
 */
function statedTheNudgeWindow(home: Home, note: (message: string) => void): void {
  let stated = false;
  edit(home.internal, (document) => {
    const block = document.getIn(['tuning', 'walk'], true);
    if (!isMap(block) || block.has('nudgeSamples')) return false;

    // The default itself, never a copy: `statedTheStepNudge` has the argument.
    const pair = document.createPair(
      'nudgeSamples',
      DEFAULT_INTERNAL.tuning.walk.nudgeSamples
    ) as Pair;
    const at = block.items.findIndex(
      (item) => isScalar(item.key) && String(item.key.value) === 'nudgeAfterMs'
    );
    if (at === -1) block.items.push(pair);
    else block.items.splice(at + 1, 0, pair);
    if (isScalar(pair.key)) pair.key.commentBefore = NUDGE_SAMPLES_COMMENT;
    /*
     * `nudgeAfterMs` is still there and still read, but it no longer means
     * what the comment written beside it says. Restated rather than left, for
     * the same reason the key is added at all: the file is where this client
     * says every deciding figure is explained.
     *
     * Only when the comment is attached to the key. A comment before a map's
     * *first* key is parsed onto the map instead — it reads as a note about
     * the whole block, and every shipped and migrated file states `holdMs`
     * ahead of this one, so the case only arises in a file somebody has
     * rearranged by hand. Rewriting a note about `walk:` because it happens
     * to sit above this key would replace something the player wrote.
     */
    const existing = block.items.find(
      (item) => isScalar(item.key) && String(item.key.value) === 'nudgeAfterMs'
    );
    if (existing && isScalar(existing.key) && existing.key.commentBefore !== undefined) {
      existing.key.commentBefore = NUDGE_AFTER_COMMENT;
    }
    stated = true;
    return true;
  });

  if (stated) note(t('notices.migration.nudgeWindowStated'));
}

/**
 * The `who` listing's line cap, in the tuning file the player owns.
 *
 * `statedTheStepNudge`' gap exactly, one block along: `reconcileWithTemplate`
 * adds an absent *top-level* block and never reaches inside one, and every
 * `internal.yaml` copied since `tuning:` existed states `parse:` — so a key
 * added under it reaches nobody who has already run the client.
 *
 * It matters more here than for most, because the number this replaces was
 * wrong in a way nothing said out loud. The cap lived beside the pattern at
 * **60**, and a realm with more adventurers than that truncated its own roster:
 * everybody past the sixtieth row was dropped, the listing stopped marking
 * them online, and the rows after the cut were fed back through the classifier
 * one at a time. The reported symptom was a `who` listing on screen with the
 * client saying the person on it was offline.
 *
 * Beside `descriptionLines`, where the shipped file puts it, so a migrated
 * tuning file reads as a fresh one. Falls back to appending when the block has
 * been rearranged by hand.
 */
function statedTheRosterCap(home: Home, note: (message: string) => void): void {
  let stated = false;
  edit(home.internal, (document) => {
    const block = document.getIn(['tuning', 'parse'], true);
    if (!isMap(block) || block.has('rosterLines')) return false;

    // The default itself, never a copy: `statedTheStepNudge` has the argument.
    const pair = document.createPair(
      'rosterLines',
      DEFAULT_INTERNAL.tuning.parse.rosterLines
    ) as Pair;
    const at = block.items.findIndex(
      (item) => isScalar(item.key) && String(item.key.value) === 'descriptionLines'
    );
    if (at === -1) block.items.push(pair);
    else block.items.splice(at + 1, 0, pair);
    if (isScalar(pair.key)) pair.key.commentBefore = ROSTER_LINES_COMMENT;
    stated = true;
    return true;
  });

  if (stated) note(t('notices.migration.rosterCapStated'));
}

/**
 * `view.mapRoomPixels` becomes the two ends of the Map card's density slider.
 *
 * One figure decided for the player how much of the realm a map showed. The
 * card has a density slider now, and what it chooses between are two named
 * ends — so the single key is a setting nothing reads, which is
 * `dropStandUpThresholds`' rule: a value in a file that no screen can edit and
 * no code can read is one somebody fills in and then waits to see work.
 *
 * **The old figure is not carried into either end.** It was the answer to a
 * different question — *the* room budget, rather than one end of a range — and
 * writing 34 into `mapRoomPixelsSparse` would make the sparse end of somebody's
 * slider mean whatever they had tuned the old single value to, with the dense
 * end shipped. That is two settings that no longer relate to each other, which
 * is worse than the pair the template ships. Said out loud for that reason.
 *
 * `mapRadiusMin` goes 3 -> 2 with them, and **only where it still states the
 * old default**: 5x5 rooms is a radius of two and the old floor would quietly
 * refuse the sparse end of the slider, but a floor somebody has tuned
 * themselves is their answer and not this one's.
 */
function mapDensityHasTwoEnds(home: Home, note: (message: string) => void): void {
  let changed = false;
  edit(home.internal, (document) => {
    const block = document.getIn(['tuning', 'view'], true);
    if (!isMap(block)) return false;

    const had = block.has('mapRoomPixels');
    if (!had && block.has('mapRoomPixelsSparse')) return false;

    let touched = false;
    const at = block.items.findIndex(
      (item) => isScalar(item.key) && String(item.key.value) === 'mapRoomPixels'
    );
    if (at !== -1) {
      block.items.splice(at, 1);
      touched = true;
    }
    const ends: Array<['mapRoomPixelsSparse' | 'mapRoomPixelsDense', number]> = [
      ['mapRoomPixelsSparse', DEFAULT_INTERNAL.tuning.view.mapRoomPixelsSparse],
      ['mapRoomPixelsDense', DEFAULT_INTERNAL.tuning.view.mapRoomPixelsDense]
    ];
    let first: Pair | null = null;
    let insert = at === -1 ? block.items.length : at;
    for (const [key, value] of ends) {
      if (block.has(key)) continue;
      const pair = document.createPair(key, value) as Pair;
      block.items.splice(insert, 0, pair);
      insert += 1;
      if (first === null) first = pair;
      touched = true;
    }
    if (first !== null && isScalar(first.key)) first.key.commentBefore = MAP_DENSITY_COMMENT;

    // Only where it is still the figure this build is moving. A floor somebody
    // tuned themselves is their answer.
    const floor = block.get('mapRadiusMin');
    if (floor === 3) {
      block.set('mapRadiusMin', DEFAULT_INTERNAL.tuning.view.mapRadiusMin);
      touched = true;
    }
    changed = touched;
    return touched;
  });

  if (changed) note(t('notices.migration.mapDensityStated'));
}

/** The template's own words for the pair, so the two files read alike. */
const MAP_DENSITY_COMMENT = ` How many pixels one room's cell wants, at each end of the Map card's
 density slider -- sparse first, dense second. The legibility budget: how
 small a room may be drawn and still be a thing somebody can point at.

 There was one figure, 34, and it decided for the player how much of the
 realm a map showed. The ends are chosen so a rail-sized card spans 5x5
 rooms at the sparse end and 20x20 at the dense one.`;

/** The template's own words for the key, so the two files read alike. */
const ROSTER_LINES_COMMENT = ` Cap on the lines of a \`who\` listing -- the one listing whose length is the
 realm's business rather than the pattern's, because it has one row per
 person logged in. What actually ends the listing is the status line the
 server prints after it; this is the backstop for a realm whose prompt this
 client has never met, so it has to sit above any population you play on.
 It was 60 beside the pattern, and a busier realm silently lost everybody
 past the sixtieth row -- a \`who\` on screen with the client calling the
 person on it offline.`;

/**
 * `bank` added to the entry probe, in the file the player actually owns.
 *
 * `reconcileWithTemplate` never reaches inside a block, and every file copied
 * since `automation:` existed states `onEnterRealm` — so a command added to
 * the shipped list reaches nobody who has already run the client. That is the
 * same gap `pinTheLoopShelf` closes for the toolbar row, and the same reason:
 * a default nobody can see in their own file is a default nobody gets.
 *
 * Placed **before a trailing `l`**, where the shipped list put it, so the last
 * thing the entry probe left on screen was still the room. Appending would
 * have ended the sequence on a balance, or on the refusal a character that
 * logged out away from a counter gets. The shipped list no longer ends in a
 * look at all — `stoppedAnnouncingTheLook` runs after this one and takes a
 * trailing one out — so for a file that still has one this only decides the
 * order the two steps leave behind.
 *
 * The honest limit, and it is the one `pinTheLoopShelf` also has: a *list* has
 * no way to say "I took this out on purpose". A key added to a map stays
 * added once it is there whatever its value, but somebody who deletes `bank`
 * from this list looks exactly like somebody who never had it, and will get it
 * back on the next launch. The alternative — a record of which migrations have
 * run — is a second file about the user's files, and this client does not
 * keep one.
 */
function askedTheBankOnEntry(home: Home, note: (message: string) => void): void {
  const files = [home.options, ...directories(home.profilesDir).map((id) => home.profile(id).file)];
  const asked: string[] = [];

  for (const file of files) {
    edit(file, (document) => {
      const list = document.getIn(['automation', 'onEnterRealm'], true);
      if (!isSeq(list)) return false;

      const commands = list.items.map((item) => (isScalar(item) ? String(item.value) : null));
      // Already there — a file edited by hand, or a second run of this.
      if (commands.includes('bank')) return false;

      const last = commands.length - 1;
      const at = last >= 0 && commands[last] === 'l' ? last : commands.length;
      list.items.splice(at, 0, new Scalar('bank'));
      asked.push(file);
      return true;
    });
  }

  if (asked.length === 0) return;
  const params = { count: asked.length, fileList: asked.join(', ') };
  note(
    asked.length === 1
      ? t('notices.migration.bankAskedOnEntry.one', params)
      : t('notices.migration.bankAskedOnEntry.many', params)
  );
}

/** The look, in every spelling the realm accepts from one letter up. */
const LOOK_WORDS = new Set(['l', 'lo', 'loo', 'look']);

/**
 * The client stopped re-reading rooms with `l`, in the files that say so.
 *
 * `l` prints the room *and* broadcasts `<name> is looking around the room.` to
 * everybody standing there — a sentence this client already reads as
 * `player-looks`, from the other side. Sent on the idle tick it is a beacon
 * every forty-five seconds for as long as the client is connected; sent on
 * entering the realm it announces the arrival it was asked to read. A bare
 * Enter prints the same block and says nothing to anybody, so that is what the
 * client sends now (`REREAD_ROOM`) — and the two places the *player's* file
 * still names `l` have to move with it, or the change reaches nobody who has
 * already run the client. Same gap as `askedTheBankOnEntry`, same reason.
 *
 * Two edits, both conservative:
 *
 * - **`automation.idle.command`** becomes empty — a bare Enter — but only when
 *   it is still a look. Anything else there is a command somebody chose.
 * - **A trailing look in `automation.onEnterRealm`** is dropped rather than
 *   replaced: a list of command words has no spelling for a bare Enter, and
 *   the server prints the room on entering the realm anyway. Only a trailing
 *   one, because a look in the middle of the list was put there to separate
 *   two answers and removing it would change what the console shows.
 *
 * The honest limit is `askedTheBankOnEntry`'s: nothing records which
 * migrations have run, so somebody who *wants* the idle look back has to say
 * so in a spelling this does not match — `look` with an argument, or any of
 * the abbreviations after a hand edit. It runs once against a file that still
 * reads as the old default and never again, because after it the value no
 * longer matches.
 */
function stoppedAnnouncingTheLook(home: Home, note: (message: string) => void): void {
  const files = [home.options, ...directories(home.profilesDir).map((id) => home.profile(id).file)];
  const quietened: string[] = [];

  for (const file of files) {
    edit(file, (document) => {
      let changed = false;

      const idle = document.getIn(['automation', 'idle', 'command'], true);
      if (isScalar(idle) && LOOK_WORDS.has(String(idle.value).trim().toLowerCase())) {
        // Quoted, so an empty scalar reads as a deliberate value rather than
        // as a key somebody forgot to finish.
        idle.value = '';
        idle.type = Scalar.QUOTE_SINGLE;
        changed = true;
      }

      const list = document.getIn(['automation', 'onEnterRealm'], true);
      if (isSeq(list)) {
        const last = list.items.at(-1);
        if (isScalar(last) && LOOK_WORDS.has(String(last.value).trim().toLowerCase())) {
          list.items.pop();
          changed = true;
        }
      }

      if (changed) quietened.push(file);
      return changed;
    });
  }

  if (quietened.length === 0) return;
  const params = { count: quietened.length, fileList: quietened.join(', ') };
  note(
    quietened.length === 1
      ? t('notices.migration.lookNoLongerBroadcast.one', params)
      : t('notices.migration.lookNoLongerBroadcast.many', params)
  );
}

/** In template order, so a file that gains all four reads like the shipped one. */
/**
 * The blocks and keys 2026-09-01 added — dropping junk, banking the purse,
 * defending the party, the crowd spell, and the PvP reaction. Same gap
 * `statedDoorForcing` closes and for the same reason: `reconcileWithTemplate`
 * never reaches inside `automation:`, so a setting added there reaches nobody
 * who has already run the client, and here the template is the documentation.
 *
 * Two grains, on the precedent that function set. The keys that live *inside*
 * a block (`safety.pvp`, `party.defendParty`, the three `spells.area*`) are
 * written wherever that block is already stated — the options file always
 * states them, and a profile stating one has opted into pinning its keys. The
 * two whole new blocks (`drop:`, `banking:`) are written into the **options
 * file only**: a profile that never mentioned them inherits, and writing
 * defaults into every profile would freeze today's defaults into each.
 *
 * The values written are the defaults, so nothing about how the client
 * behaves changes; what changes is that the file says so. Nothing stated is
 * ever overwritten.
 */
function statedTheNewAutomation(home: Home, note: (message: string) => void): void {
  const files = [home.options, ...directories(home.profilesDir).map((id) => home.profile(id).file)];
  const stated: string[] = [];

  const addKeys = (
    document: Document,
    parent: readonly string[],
    keys: ReadonlyArray<readonly [string, unknown]>,
    comment: string
  ): boolean => {
    const block = document.getIn([...parent], true);
    if (!isMap(block)) return false;
    let changed = false;
    let first: Pair | null = null;
    for (const [key, value] of keys) {
      if (block.has(key)) continue;
      const pair = document.createPair(key, value) as Pair;
      block.items.push(pair);
      if (first === null) first = pair;
      changed = true;
    }
    if (first !== null && isScalar(first.key)) first.key.commentBefore = comment;
    return changed;
  };

  for (const file of files) {
    edit(file, (document) => {
      let changed = false;
      // The whole new blocks, in the options file alone.
      if (file === home.options) {
        if (addKeys(document, ['automation'], [['drop', DROP_DEFAULT]], DROP_COMMENT)) {
          changed = true;
        }
        if (addKeys(document, ['automation'], [['banking', BANKING_DEFAULT]], BANKING_COMMENT)) {
          changed = true;
        }
        if (addKeys(document, ['automation'], [['quests', QUESTS_DEFAULT]], QUESTS_COMMENT)) {
          changed = true;
        }
        if (addKeys(document, ['automation'], [['gear', GEAR_DEFAULT]], GEAR_COMMENT)) {
          changed = true;
        }
      }
      // The keys inside blocks a file already states.
      if (addKeys(document, ['automation', 'safety'], [['pvp', PVP_DEFAULT]], PVP_COMMENT)) {
        changed = true;
      }
      if (
        addKeys(document, ['automation', 'party'], [['defendParty', false]], DEFEND_PARTY_COMMENT)
      ) {
        changed = true;
      }
      if (addKeys(document, ['automation', 'spells'], AREA_SPELL_DEFAULTS, AREA_SPELL_COMMENT)) {
        changed = true;
      }
      if (
        addKeys(
          document,
          ['automation', 'spells'],
          [['notifyPartyOnWearOff', false]],
          NOTIFY_WEAR_OFF_COMMENT
        )
      ) {
        changed = true;
      }
      if (addKeys(document, ['automation', 'spells'], [['autoBless', true]], AUTO_BLESS_COMMENT)) {
        changed = true;
      }
      if (
        addKeys(
          document,
          ['automation', 'movement'],
          [['fightOnArrival', true]],
          FIGHT_ON_ARRIVAL_COMMENT
        )
      ) {
        changed = true;
      }
      if (
        addKeys(document, ['automation', 'party'], [['askForHealBelow', 0]], ASK_FOR_HEAL_COMMENT)
      ) {
        changed = true;
      }
      if (addKeys(document, ['automation', 'health'], [['useWards', true]], USE_WARDS_COMMENT)) {
        changed = true;
      }
      if (
        addKeys(
          document,
          ['automation', 'combat'],
          [['defendAfterRounds', 2]],
          DEFEND_AFTER_ROUNDS_COMMENT
        )
      ) {
        changed = true;
      }
      if (changed) stated.push(file);
      return changed;
    });
  }

  if (stated.length === 0) return;
  const params = { count: stated.length, fileList: stated.join(', ') };
  note(
    stated.length === 1
      ? t('notices.migration.newAutomationStated.one', params)
      : t('notices.migration.newAutomationStated.many', params)
  );
}

/**
 * The three settings the room's and the pack's entities made possible.
 *
 * `loot.minPrice`, `loot.maxEncumbrance` and `drop.worthless` all ask the realm
 * a question about a *thing* — what is it worth, what does it weigh — and none
 * of them could be asked before an item arrived with the realm's row joined to
 * it. Written at their defaults, all off, so nothing about how the client
 * behaves changes; what changes is that the file says they exist.
 *
 * Same gap `statedTheNewAutomation` closes and for the same reason:
 * `reconcileWithTemplate` never reaches inside a block that is already stated.
 */
function statedTheEntityPredicates(home: Home, note: (message: string) => void): void {
  const files = [home.options, ...directories(home.profilesDir).map((id) => home.profile(id).file)];
  const stated: string[] = [];

  for (const file of files) {
    edit(file, (document) => {
      let changed = false;
      const add = (parent: readonly string[], key: string, value: unknown, comment: string) => {
        const block = document.getIn([...parent], true);
        if (!isMap(block) || block.has(key)) return;
        const pair = document.createPair(key, value) as Pair;
        block.items.push(pair);
        // A run of keys shares one comment: the first carries it and the rest
        // pass '', which must not become a bare `#` above the line.
        if (comment.length > 0 && isScalar(pair.key)) pair.key.commentBefore = comment;
        changed = true;
      };
      add(['automation', 'combat'], 'minMobs', 0, '');
      add(['automation', 'combat'], 'maxMonsterExperience', 0, '');
      add(['automation', 'spells'], 'healBelowInCombat', 0, HEAL_IN_COMBAT_COMMENT);
      add(['automation', 'combat'], 'maxTargetHealth', 0, COMBAT_KIND_COMMENT);
      add(['automation', 'loot'], 'coinKinds', [...DENOMINATIONS], LOOT_COINS_COMMENT);
      add(['automation', 'loot'], 'stopAtGrade', 'never', LOOT_GRADE_COMMENT);
      add(['automation', 'loot'], 'convertWith', '', LOOT_CONVERT_COMMENT);
      add(['automation', 'loot'], 'convertAt', 'never', '');
      add(['automation', 'loot'], 'minPrice', 0, LOOT_VALUE_COMMENT);
      add(['automation', 'loot'], 'maxEncumbrance', 0, LOOT_WEIGHT_COMMENT);
      add(['automation', 'drop'], 'worthless', false, DROP_WORTHLESS_COMMENT);
      add(['automation', 'banking'], 'bank', 0, BANK_WHICH_COMMENT);
      if (changed) stated.push(file);
      return changed;
    });
  }

  if (stated.length === 0) return;
  const params = { count: stated.length, fileList: stated.join(', ') };
  note(
    stated.length === 1
      ? t('notices.migration.entityPredicates.one', params)
      : t('notices.migration.entityPredicates.many', params)
  );
}

/**
 * The heal became two spells and gained a ceiling.
 *
 * `spells.heal` used to be cast on this character *and* on whichever party
 * member fell under the threshold, which the realm does not allow for a great
 * many heals: `Spells.Targets` marks `way of the swan` castable on the caster
 * alone and `minor healing` castable on anybody, and one field for both meant
 * a mystic who configured a self heal silently armed `c swan <name>` once a
 * round for a refusal the server prints out loud in the room. So there are two
 * — `heal` and `healPartyWith` — each with a picker the realm's own column
 * narrows.
 *
 * **The seed is the point of doing this here.** A file that already said
 * `healParty: true` was healing the party with `heal`, so `heal` is copied
 * into `healPartyWith`: the migration preserves what the client was doing
 * rather than quietly switching party healing off. A file with `healParty`
 * off, or no heal configured, gets the blank — there is nothing to preserve.
 * The settings screen then shows whether that copied spell is one the realm
 * will actually let this character cast on somebody else, which is the fact
 * that was unavailable before.
 *
 * `healTo` is new and defaults to 0, which is the single cast at the threshold
 * the client has always done — so nothing changes until somebody sets it.
 *
 * Same gap `statedTheNewAutomation` closes and for the same reason:
 * `reconcileWithTemplate` never reaches inside `automation:`, so a key added
 * to a block reaches nobody who has already run the client.
 */
function splitTheHealSpell(home: Home, note: (message: string) => void): void {
  const files = [home.options, ...directories(home.profilesDir).map((id) => home.profile(id).file)];
  const split: string[] = [];

  for (const file of files) {
    edit(file, (document) => {
      const spells = document.getIn(['automation', 'spells'], true);
      if (!isMap(spells)) return false;
      let changed = false;
      let first: Pair | null = null;

      if (!spells.has('healPartyWith')) {
        /*
         * Only where the file was actually healing the party. A `heal` copied
         * into a file that had `healParty` off would arm party healing the
         * moment somebody pressed the toolbar toggle, with a spell they never
         * chose for it.
         */
        const healing = document.getIn(['automation', 'spells', 'healParty']) === true;
        const heal = document.getIn(['automation', 'spells', 'heal']);
        const seed = healing && typeof heal === 'string' ? heal.trim() : '';
        const pair = document.createPair('healPartyWith', seed) as Pair;
        spells.items.push(pair);
        first = pair;
        changed = true;
      }
      if (!spells.has('healTo')) {
        const pair = document.createPair('healTo', 0) as Pair;
        spells.items.push(pair);
        if (first === null) first = pair;
        changed = true;
      }
      if (first !== null && isScalar(first.key)) first.key.commentBefore = HEAL_SPLIT_COMMENT;
      if (changed) split.push(file);
      return changed;
    });
  }

  if (split.length === 0) return;
  const params = { count: split.length, fileList: split.join(', ') };
  note(
    split.length === 1
      ? t('notices.migration.healSplit.one', params)
      : t('notices.migration.healSplit.many', params)
  );
}

/**
 * `spells.buffs` and `party.blessings` became one list, `spells.blessings` —
 * event-driven with a fallback clock, per-entry targets, and priority order.
 *
 * The rows are **carried, not restated**: each old entry keeps its name,
 * spell and mana floor, its `intervalSeconds` becomes `fallbackSeconds` (the
 * same number, doing the same job — how long the spell is trusted to last),
 * and the target says which list it came from. The new per-entry switches
 * are left unstated so the file stays sparse and the shipped defaults
 * decide, exactly as a fresh file would.
 *
 * Nothing is overwritten: a file that already states `spells.blessings` is
 * left entirely alone, old keys included — those are then the record of what
 * was not carried, not clutter to tidy.
 */
function mergedBuffsIntoBlessings(home: Home, note: (message: string) => void): void {
  const files = [home.options, ...directories(home.profilesDir).map((id) => home.profile(id).file)];
  const merged: string[] = [];

  for (const file of files) {
    edit(file, (document) => {
      const spells = document.getIn(['automation', 'spells'], true);
      const party = document.getIn(['automation', 'party'], true);
      const oldBuffs = isMap(spells) ? spells.get('buffs', true) : undefined;
      const oldBlessings = isMap(party) ? party.get('blessings', true) : undefined;
      if (oldBuffs === undefined && oldBlessings === undefined) return false;
      if (isMap(spells) && spells.has('blessings')) return false;

      const rows: Array<Record<string, unknown>> = [];
      const carry = (node: unknown, target: 'self' | 'party'): void => {
        if (!isSeq(node)) return;
        for (const item of node.items) {
          if (!isMap(item)) continue;
          const name = item.get('name');
          const spell = item.get('spell');
          // A row the old shape would have dropped is not carried either.
          if (typeof name !== 'string' || typeof spell !== 'string') continue;
          /*
           * `inCombat: false` is written out, not left to the default: the
           * module these rows come from refused combat outright, and the new
           * default for a self target is `true`. A migration that changed
           * what the client does mid-fight would not be carrying rows, it
           * would be re-deciding them. A fresh row somebody adds gets the
           * new default; a carried one keeps its old behaviour.
           */
          const row: Record<string, unknown> = { name, spell, target, inCombat: false };
          const minMana = item.get('minMana');
          if (typeof minMana === 'number') row['minMana'] = minMana;
          const interval = item.get('intervalSeconds');
          if (typeof interval === 'number') row['fallbackSeconds'] = interval;
          rows.push(row);
        }
      };
      carry(oldBuffs, 'self');
      carry(oldBlessings, 'party');

      document.setIn(['automation', 'spells', 'blessings'], rows);
      const written = document.getIn(['automation', 'spells'], true);
      if (isMap(written)) {
        const pair = written.items.find(
          (entry) => isScalar(entry.key) && entry.key.value === 'blessings'
        );
        if (pair && isScalar(pair.key)) pair.key.commentBefore = BLESSINGS_COMMENT;
        written.delete('buffs');
      }
      if (isMap(party)) party.delete('blessings');
      merged.push(file);
      return true;
    });
  }

  if (merged.length === 0) return;
  const params = { count: merged.length, fileList: merged.join(', ') };
  note(
    merged.length === 1
      ? t('notices.migration.blessingsMerged.one', params)
      : t('notices.migration.blessingsMerged.many', params)
  );
}

/** The template's words, abridged, on the key this migration writes. */
const BLESSINGS_COMMENT = ` Blessings kept up on this character and the party, in priority order --
 replaces spells.buffs and party.blessings. Event-driven: the cast
 confirmation establishes a buff and the wear-off sentence recasts it the
 moment it ends; on a party row \`fallbackSeconds\` (was intervalSeconds)
 is the recast clock, and a self row's watchdog is measured from your own
 casts instead. \`target\` is self or party;
 \`inCombat\` and \`prioritizeOverHeal\` are per-entry -- the template
 explains all of them.`;

/**
 * A blessing row lost its separate display name and its always-on clock
 * (2026-09-01): the spell is the row's identity — the first person to use
 * the form typed the spell into the name box and lost the row to the silent
 * no-spell filter — and a self row's watchdog is now measured from the
 * character's own cast→wear-off pairs rather than typed, so `fallbackSeconds`
 * remains only on party rows, whose wear-offs print on the member's screen.
 *
 * Runs after `mergedBuffsIntoBlessings` on purpose: rows that step carries
 * out of the old shape are normalised here in the same pass. A row whose
 * `name` differed from its `spell` keeps the spell — the name was never sent
 * anywhere — and a self row's clock is dropped rather than translated,
 * because there is nothing honest to translate it into.
 */
function keyedBlessingsOnSpell(home: Home, note: (message: string) => void): void {
  const files = [home.options, ...directories(home.profilesDir).map((id) => home.profile(id).file)];
  const changed: string[] = [];

  for (const file of files) {
    edit(file, (document) => {
      const rows = document.getIn(['automation', 'spells', 'blessings'], true);
      if (!isSeq(rows)) return false;
      let touched = false;
      for (const item of rows.items) {
        if (!isMap(item)) continue;
        if (item.has('name')) {
          item.delete('name');
          touched = true;
        }
        if (item.get('target') !== 'party' && item.has('fallbackSeconds')) {
          item.delete('fallbackSeconds');
          touched = true;
        }
      }
      if (!touched) return false;
      changed.push(file);
      return true;
    });
  }

  if (changed.length === 0) return;
  const params = { count: changed.length, fileList: changed.join(', ') };
  note(
    changed.length === 1
      ? t('notices.migration.blessingsKeyedOnSpell.one', params)
      : t('notices.migration.blessingsKeyedOnSpell.many', params)
  );
}

const NOTIFY_WEAR_OFF_COMMENT = ` Tell the party member who blessed you when their spell wears off --
 \`/<caster> @bless-expired <spell>\` -- so their client recasts on the event
 instead of its clock. Both ends must run mudengine. Off: it speaks on
 somebody's telepath channel unasked.`;

const FIGHT_ON_ARRIVAL_COMMENT = ` Turn auto-combat back on when a route you asked for arrives: walking
 with it off is how you get somewhere without fighting on the way, and on
 arrival that reason is gone. Flips the switch in this file.`;

const DEFEND_AFTER_ROUNDS_COMMENT = ` With auto-combat off, or a route run with it off, being hit for this many
 rounds without moving turns it on until you next arrive in another room.
 Off means do not start fights; it never meant stand there and be killed.
 Flips the switch in this file, both ways. 0 never does.`;

const HANG_PENALTIES_COMMENT = ` Whether this realm charges for a hang-up at all. Off: below belowHealth
 the client simply hangs up. Paradigm's realm menu states it, and that
 outranks this; so does a realm's own server.yaml (hangPenalties).`;

const USE_WARDS_COMMENT = ` The realm's own half of the potion rules above: where it says a spell
 stops a room's effect and a carried item's use casts it -- the waterskin
 against the desert spell -- use the item before the step into such a room,
 and again whenever the spell lapses while standing in one. On, for the reason
 the torch is; a use spends a charge.`;

const AUTO_BLESS_COMMENT = ` Whether the blessings above are cast unasked at all. The toolbar's
 Auto-Bless switch: off keeps the mana for healing through a fight without
 emptying the list; the cures and the heal are untouched.`;

const DROP_DEFAULT = { enabled: false, items: [], whenEncumbered: false };
/** The template's own words, abridged, so the two files read alike. */
const DROP_COMMENT = ` Dropping named junk, unasked -- the other half of MegaMUD's drop list.
 \`items\` is the only authority on what is junk: nothing you did not name is
 ever dropped, and never anything worn, wielded or lit. Matched by prefix,
 as the server reads \`drop\`. \`whenEncumbered\` holds the junk until the
 server itself grades the load as anything but None. Off by default.`;

const BANKING_DEFAULT = { autoDeposit: false, depositThresholdCopper: 50_000, keepCopper: 500 };
/** Running a quest's plan (todo 102): off, like everything automated. */
const GEAR_DEFAULT = { enabled: false, sets: [], offRound: { item: '', everyRounds: 0 } };
const GEAR_COMMENT = ` Which kit to be in, and when -- the equipment manager.

 A set names only the slots it cares about, and the kit is the \`always\` set
 overlaid by whichever other set applies: \`when\` is \`always\`, \`moving\` (a
 route or a lap under way) or \`fighting\`, and a fighting set may add \`mob:\`
 to apply against one monster only. The off-hand comes off before a two-handed
 weapon goes on, off the realm's own \`Items.WeaponType\`.

 \`offRound\` is \`use <item> <target>\` between rounds. It costs the round --
 the server will not use a weapon that is not in hand -- so \`everyRounds\` is
 the floor under it and 0, where it ships, is off.`;
const QUESTS_DEFAULT = { enabled: false };
const QUESTS_COMMENT = ` Running a quest's plan -- the Quest card's Run it.

 With \`enabled\` on, Run it carries a plan one step at a time: the pack is
 read, each item is bought, hunted or asked for the way the plan says, the way
 to the act is walked as a leg, the act is sent, and the counter is read back
 with \`abil\` before the next step starts. Off, because a run walks across
 the realm, buys, hunts and fights for as long as the chain takes.`;
const BANKING_COMMENT = ` Banking the purse, unasked -- MegaMUD's StashCoin. At a bank counter with
 more than \`depositThresholdCopper\` in the purse, deposits everything above
 \`keepCopper\` and asks \`bank\` behind it. Both numbers are copper: 10 to the
 silver, 100 to the gold crown, 10,000 to the platinum -- the defaults are
 500 gold and 5 gold. Never on an unread purse, never in combat or resting.
 Off by default.`;

const PVP_DEFAULT = { notifyGang: false, action: 'none' };
const PVP_COMMENT = ` What to do the moment a player opens on you. \`notifyGang\` says so on the
 gangpath (\`bg\`), once per attacker per five-minute window, with the room
 and your health riding along. \`action\` is \`none\` or \`retreat\` -- the retreat
 runs the moment the attack is seen, whatever retreat.enabled says. Both off:
 the broadcast speaks to your whole gang, and running away is the client
 deciding a fight is lost.`;

const DEFEND_PARTY_COMMENT = ` Swing at a monster seen attacking any party member -- MegaMUD's
 DefendParty. The fight came to the party, so combat.engage does not gate
 it, but every other combat gate does. Never a player on either end.`;

const ASK_FOR_HEAL_COMMENT = ` Say @heal in the room when health falls below this share of maximum while
 in a party -- MegaMUD's Ask For Healing. A member running MegaMUD or this
 client answers with a heal. Said on the crossing and again every
 tuning.remotes.healAskAgainMs while still under it. 0 never asks.`;

const AREA_SPELL_DEFAULTS: ReadonlyArray<readonly [string, string | number]> = [
  ['areaAttack', ''],
  ['areaMinMobs', 3],
  ['areaMinMana', 0.35]
];
const AREA_SPELL_COMMENT = ` The spell for a crowded room -- MegaMUD's MultAttack. When at least
 \`areaMinMobs\` threats stand in the room and mana clears \`areaMinMana\` (or
 minMana, whichever is higher), this is cast instead of \`attack\` -- bare,
 with no target, which is how the wire shows an area cast. Never while a
 monster the realm calls good stands in the room: a room spell hits
 everything, and the ten evil points are a cost no setting spends unasked.
 Blank casts nothing.`;

const BANK_WHICH_COMMENT = ` Which counter this character's vault is at, as a \`Shops\` row id -- the
 settings screen picks it from the realm's own list. 0 is whichever counter it
 happens to be standing at, which is what this did before the setting existed.
 A balance is per counter, so banking wherever you walk past leaves several
 figures that cannot be added up.`;

const COMBAT_KIND_COMMENT = ` A refusal from the realm's own column rather than a name: more health than
 you want to open on. 0 never refuses. Silent where the realm says nothing,
 and it does not touch retaliation.`;

const NUDGE_AFTER_COMMENT = ` How much longer than this realm's own slowest answer a step may go unanswered
 before the walk sends one bare Enter to force a status line out of the server.

 A margin over a measurement, never a claim about the server. This used to be
 the whole deadline and meant "a move is answered in well under a second" --
 true of one realm, stated about all of them. Paradigm's movement round is a
 measured 1,239ms, so the fallback fired on every step of every walk, and the
 bare Enter it sends is answered with a full reprint of the room: every room
 appeared twice, all the way round the lap.

 The walk now measures what a move actually costs on your realm and this is the
 headroom on top. It is also the whole deadline until a move has been answered
 once, which is the only moment there is nothing to measure against. One per
 step; the full stepTimeoutMs runs behind it before the walk gives up.`;

const NUDGE_SAMPLES_COMMENT = ` How many recent move answers that deadline is measured over.

 The statistic is the slowest of them: the deadline exists to be later than a
 normal answer, and one fast answer says nothing about the slow case -- a step
 whose room dead reckoning had already placed answers in a millisecond and is
 not evidence the realm is quick. A window rather than an all-time maximum, so
 one lagged answer ages out instead of standing the fallback down for the
 evening.`;

const REPLAN_DRIFT_COMMENT = ` How far the character may have strayed from the room a drawn plan
 starts in before pressing Walk asks about the plan it is redrawn as.

 A plan is drawn from where the character stood when it was drawn, and a lap or
 a party leader moves it while the panel is open -- so the press used to earn
 "that route does not start here", with nothing to do about it but draw the
 same plan again. It is redrawn from here instead, and the only question left
 is whether the reader is still looking at the journey they agreed to.

 Counted in the router's own steps, not in map squares. Past this, the new plan
 is put back on screen to be read. 0 asks every time.`;

const SHOW_LOGO_COMMENT = ` The client's own mark, at the left of the status rail.

 On by default: it is the one place the client says what it is, and a brand
 nobody ever sees is the same as none. Turn it off if you would rather the
 status rail held nothing but facts about the session -- it is not in the way of
 anything either way, since it takes the height that line already has.`;

const REST_TO_COMMENT = ` Keep sitting back down until health reaches this; 0 is the single sit-down at
 the figure above, which is what this client did before the key existed. The
 server keeps you resting long past \`restBelow\` for free, so that figure only
 describes how a rest begins -- and the first thing to break one above it left
 the character standing for the whole recovery. Casting is one of those things
 (measured 2026-09-02), and standing regenerates six times slower. Set this and
 you get rest, heal, rest, heal. A figure below \`restBelow\` is lifted to it.`;

const REST_BEFORE_TRAPS_COMMENT = ` Rest before stepping through a trap, until health covers what the trap does
 and still leaves this share of maximum after it -- a sliding scale, so a
 36-damage trap in front of 165 HP is fine at 110 and a 75-damage one wants
 150. Where the room beyond is a lair the router priced, the larger share is
 kept. 0 walks into any trap at any health.`;

const HEAL_IN_COMBAT_COMMENT = ` A different heal floor while in combat, when one is wanted -- MegaMUD's
 HpHealAtt%. A heal cast at 80% mid-fight is a round spent not hitting
 anything, and the round is what the fight is made of. 0 uses \`healBelow\` for
 both, which is what this client did before the field existed.`;

const LOOT_COINS_COMMENT = ` Which coins are worth bending down for. All five is what \`coins: true\` alone
 has always meant, so this changes nothing until you take one out -- and the
 cheap ones are most of what drops: every \`get copper\` is a command out of the
 budget the fighting is done from. An empty list takes none.`;

const LOOT_GRADE_COMMENT = ` Stop collecting coins once the server grades the load this heavily --
 \`never\`, \`medium\` or \`heavy\`. The server's own word off the inventory
 listing, never a percentage this client computed; a word it cannot rank leaves
 the gate closed, because unknown is not encumbered.`;

const LOOT_CONVERT_COMMENT = ` An item that turns small coin into large -- GreaterMUD's coin bag, which
 Daeron Darksong drops. Blank never converts, and MajorMUD has no such item.
 The client cannot tell which item does this and does not pretend to, so name
 it yourself; \`convertAt\` says how loaded to be before using it.`;

const LOOT_VALUE_COMMENT = ` Also take anything the realm prices at or above this, in copper. 0 never
 does, and an item the realm cannot price is never taken by it -- a price
 nobody has stated is not a high one, and \`items\` above is the instruction
 that does not depend on data the realm may not have.`;

const LOOT_WEIGHT_COMMENT = ` Never pick anything heavier up, whatever else says to -- this outranks a name
 on the list, because the failure it exists for is an unattended character
 looting itself over the encumbrance the walker then stalls under. 0 never
 refuses, and an item the realm cannot weigh is not refused: unknown is not
 heavy.`;

const DROP_WORTHLESS_COMMENT = ` Also drop anything the realm prices at zero, without naming it. Its explicit
 zero only, never its silence: a price nobody has stated is not a price of
 nothing, and dropping on absence would empty a kit into the road on the first
 realm this client has no data for. Nothing marked Not Droppable is dropped by
 it, and nothing equipped.`;

const HEAL_SPLIT_COMMENT = ` Healing is two spells, because the realm distinguishes them: \`heal\` is cast
 on this character (bare, which is how a targetless cast lands on the caster)
 and \`healPartyWith\` on a party member. A spell the realm marks self-only --
 \`way of the swan\` -- cannot be the second, and the settings screen's pickers
 offer each field only what \`Spells.Targets\` says it may cast. Blank heals
 nobody.
   \`healBelow\` starts the healing and \`healTo\` stops it: 0.5 and 0.9 means
 begin at half health and keep casting on that target until it is back to 90%.
 A \`healTo\` of 0 is one cast at the threshold, which is what this client did
 before the pair existed.`;

const CONVERSATION_LOG_DEFAULTS: ReadonlyArray<readonly [string, boolean | number]> = [
  ['conversations', true],
  ['conversationDays', 365]
];

/** The template's own words for the pair, so the two files read alike. */
const CONVERSATION_LOG_COMMENT = ` Keep the Talk card's conversation history on disk, so quitting and
 restarting restores it rather than starting the card empty. One plain
 file per character, in \`talk/\`, holding only the conversation channels --
 gossip, broadcast, telepaths, says -- never a prompt, so it cannot hold a
 password. \`conversationDays\` is the cleanup: anything older is dropped
 when the log is opened, and a year is the default.`;

const LIGHT_DEFAULTS: ReadonlyArray<readonly [string, boolean]> = [
  ['provideLight', true],
  ['lightDimRooms', false],
  ['extinguishInLight', true]
];

/** The template's own words for the three, so the two files read alike. */
const LIGHT_COMMENT = ` Light, before the dark -- MegaMUD's AutoLight.

 \`provideLight\` readies a carried torch or lantern before a step into a room
 the character could not otherwise read, and on arriving in one. ON BY
 DEFAULT, the one automated thing that is: the decision is the server's own
 arithmetic (the room's level, plus the race's night vision, plus what is
 worn) and a light is readied only where that sum leaves the room unreadable
 and the light would fix it. \`lightDimRooms\` widens that to rooms the server
 describes anyway (\`dimly lit\`, \`barely visible\`). \`extinguishInLight\` puts
 the light out again in a room that does not need it, while nothing is walking
 the character, so a torch lasts the sewer rather than the walk to it.`;

const CONDITION_WAIT_DEFAULTS: ReadonlyArray<readonly [string, boolean]> = [
  ['walkWhileBlind', false],
  ['walkWhilePoisoned', false]
];

const KEY_PICKUP_DEFAULTS: ReadonlyArray<readonly [string, boolean]> = [['collectKeys', true]];

/** The template's own words for it, so the two files read alike. */
const KEY_PICKUP_COMMENT = ` The key to the door in front of you.

 A keyed exit with no key and nothing a picklock can do about it is a wall the
 router plans around -- so there is no step to be refused at and no route to
 press Walk on, and the only moment the client can do anything about it is
 while the character is standing in the room. ON BY DEFAULT, for the reason
 \`provideLight\` is: the whole of the wrong action is one \`get\` and the weight
 of a key, and the whole of refusing is the corridor.

 Narrow on purpose. It fires only where the realm names the item an exit of
 this room demands, no listing has shown that item in the pack, and the floor
 holds a name that can only be that row -- the realm has three \`iron key\`s,
 and a door opened on a coin toss is the confidently wrong answer the router
 refuses everywhere else. One \`get\` per key per room, said out loud.`;

/** The template's own words for the pair, so the two files read alike. */
const CONDITION_WAIT_COMMENT = `
 Conditions as waits -- MegaMUD's IgnoreBlind / IgnorePoison, whose
 defaults (0) wait the condition out before the script goes on. Off, a
 route or a loop stands still while the server says the character is
 blind or poisoned, and walks on when it says the condition has passed;
 the card and the tab say which condition it is waiting out. A blind
 character cannot read the room it walks into and misses every swing.
 Paralysis always holds -- a step while held is a command spent to be
 refused -- and disease is left to the cure. A cure spell under \`spells:\`
 ends the wait sooner.`;

const SUPPLIES_COMMENT = ` Keeping the pack stocked -- MegaMUD's Must Have Minimum.

 Each item names a thing to keep, the count below which the character goes
 shopping (\`min\`), the count it buys back up to (\`max\`), and the shop --
 by name, with the room it was settled to, because six rooms are called
 General Store. When the pack runs short the client holds whatever it was
 doing, walks to the shop, asks the counter what it sells, buys one at a time
 on the counter's own confirmation, and lets the loop go on from the shop.
 Per character: state a list in a character's own file, or add items from the
 Self card or the item panel. This global list is what a character with no
 list of its own inherits.

   items:
     - { name: torch, min: 3, max: 7, shop: General Store, at: { map: 1, room: 2147 } }`;

const DOOR_FORCING_DEFAULTS: ReadonlyArray<readonly [string, boolean | number]> = [
  ['pickLocks', false],
  ['pickTries', 3],
  ['bashDoors', false],
  ['bashTries', 3]
];

/** The template's own words for the block, so the two files read alike. */
const DOOR_FORCING_COMMENT = ` Forcing a barrier \`open\` cannot get past.

 \`The door is locked.\` is where opening stops: it answers the same way
 every time, so every further \`open\` is a command spent to be told what
 you already know. There are two ways past a lock and the realm records
 what each one has to beat -- \`Door [41 picklocks/strength]\` takes either
 skill, \`Key: 2126 [or 157 picklocks]\` takes only the lock-pick.

 Picking is tried first when both are on, because a pick that fails costs
 a command and a bash that fails costs a command *and* health -- and the
 game prints the damage in the room. A picked door is unlocked and still
 shut, so the client opens it afterwards; a bashed one is open already.

 Both off by default. A door somebody locked is a door somebody locked,
 and a route that forces its way through one is a decision, not a detail.`;

/** The keys under `connection:` that only the anonymous session ever read. */
const ANONYMOUS_CONNECTION_KEYS = ['autoConnect'] as const;
const ANONYMOUS_LOGIN_KEYS = ['enabled', 'username', 'password'] as const;

/**
 * `connection.autoConnect` and the account under `connection.login` go, with
 * the anonymous session that spent them.
 *
 * With no profile files the client used to open one session driven by
 * `connection:` — the shape it had before profiles existed. That session was a
 * second client with fewer parts: no file to edit, no realm memory, no fight
 * log, no tab, and credentials of its own on a page the character path never
 * read. Every feature since had to carve a case out for it. Retired
 * 2026-08-29: making a character is step one, and each carries its own
 * account and its own `autoConnect`. `connection:` stays as what a new realm
 * starts with — host, port, encoding and the menu steps.
 *
 * Only the options file: a character's file never held these keys under
 * `connection:` (its account and `autoConnect` are top-level, resolved by
 * `resolveProfile`). The comments are left as they are, like every step here.
 * **Nothing in the notice is a value**: the file may well have held a real
 * password, and the notice says the keys went, not what was in them.
 */
function dropAnonymousConnection(home: Home, note: (message: string) => void): void {
  let cleaned = false;
  editOptions(home, (document) => {
    const connection = document.get('connection', true);
    if (!isMap(connection)) return false;
    let changed = false;
    for (const key of ANONYMOUS_CONNECTION_KEYS) {
      if (connection.has(key)) {
        connection.delete(key);
        changed = true;
      }
    }
    const login = connection.get('login', true);
    if (isMap(login)) {
      for (const key of ANONYMOUS_LOGIN_KEYS) {
        if (login.has(key)) {
          login.delete(key);
          changed = true;
        }
      }
      // An emptied block reads as a setting somebody meant to fill in.
      if (login.items.length === 0) connection.delete('login');
    }
    cleaned = changed;
    return changed;
  });
  if (cleaned) note(t('notices.migration.anonymousConnectionDropped', { file: home.options }));
}

/**
 * `automation.peers` becomes `automation.remotes`, and the grounds become lists.
 *
 * Three shapes have existed. Until 2026-08-28 the switch was the whole feature:
 * on meant *every* sender was answered. Until 2026-08-29 it carried `trust`,
 * `allow` and `block` — and a *ground* allowed somebody **every** command.
 * Neither could say the thing people ask for, which is per command, so
 * permission is now stated per remote, per player, with one list for the gang.
 *
 * **The conversion is faithful where it can be and narrows where it cannot**,
 * because the safe direction for a permission is the one that grants less:
 *
 * - `trust: [named]` with `allow: [Soul]` — Soul could use everything, so Soul
 *   is written an explicit allow list of every remote this client can actually
 *   answer. Nothing is granted that was not granted before.
 * - `trust: [gang]` — the gang could use everything, so the gang list is
 *   written the same way.
 * - `trust: [party]` — **dropped**, and said out loud. There is no party ground
 *   any more: a party is a group anybody can invite anybody into, so it was a
 *   permission anybody could grant themselves by sending an invitation. A
 *   migration is the last place to keep one of those alive.
 * - `block: [Rend]` — written as an explicit deny of every remote. Inert while
 *   nothing else grants Rend anything, and exactly right the day somebody
 *   grants their gang something; a block that quietly evaporated during a
 *   rename is the failure this whole step exists to avoid.
 *
 * Only the *actionable* remotes are written, never all fifty-seven: a grant for
 * a command this client will never answer is a permission somebody sets and
 * waits to see work. `ACTIONABLE_REMOTES` is the same list the settings
 * surfaces make toggleable, so the file a migration writes and the file a
 * person could have written by clicking are the same file.
 *
 * ## A key the old block did not state is not stated by the new one
 *
 * **A profile is a sparse overlay**, and this bit once: the first version wrote
 * `enabled: peers.enabled === true` unconditionally, so a character whose file
 * said only `allow: [Soul]` — inheriting `enabled: true` from the options file
 * — came out of the migration with `enabled: false` written into it. That is a
 * migration switching a feature off, which is the one thing it must never do.
 * So only the keys the old block actually stated are carried, plus whatever the
 * conversion produced.
 *
 * ## The options file gets the template's block back, comments and all
 *
 * `reconcileWithTemplate` fills a missing *top-level* block and deliberately
 * never reaches inside one, so nothing else would ever put the new keys — or a
 * word of prose about them — into a file whose `automation:` already exists.
 * And the comment sitting above the old block describes `trust`, `allow` and
 * `block`, which is documentation for a shape that no longer exists.
 *
 * So for the options file the shipped template's `remotes` pair is used whole,
 * with the converted values set onto it: the same act `reconcileWithTemplate`
 * performs, one level deeper. **In place**, so the block stays where the file
 * had it rather than moving to the end of `automation:`.
 *
 * Idempotent, like every step here: a file that already has `remotes` is left
 * alone, and one with neither key is left to `reconcileWithTemplate`.
 */
function peersBecameRemotes(options: MigrationOptions): void {
  const { home, note, template } = options;
  const files = [home.options, ...directories(home.profilesDir).map((id) => home.profile(id).file)];
  const stated: string[] = [];
  let droppedParty = false;

  for (const file of files) {
    edit(file, (document) => {
      const automation = document.get('automation', true);
      if (!isMap(automation)) return false;
      const index = automation.items.findIndex((item) => keyText(item) === 'peers');
      if (index === -1) return false;
      const peers = automation.items[index]!.value;

      /*
       * Already converted -- a file with both keys keeps the new one, and the
       * old is dropped as the dead key it is. Guessing which the person meant
       * is how a permission gets overwritten.
       */
      if (automation.items.some((item) => keyText(item) === 'remotes')) {
        automation.items.splice(index, 1);
        stated.push(file);
        return true;
      }
      if (!isMap(peers)) return false;

      const trust = names(peers.get('trust', true));
      const grants: Record<string, { allow: string[]; deny: string[] }> = {};
      const grant = (who: string): { allow: string[]; deny: string[] } =>
        (grants[who.toLowerCase()] ??= { allow: [], deny: [] });

      if (trust.includes('named')) {
        for (const who of names(peers.get('allow', true))) {
          grant(who).allow = [...ACTIONABLE_REMOTES];
        }
      }
      for (const who of names(peers.get('block', true))) grant(who).deny = [...ACTIONABLE_REMOTES];
      if (trust.includes('party')) droppedParty = true;

      const gang = trust.includes('gang') ? [...ACTIONABLE_REMOTES] : [];
      const shipped = file === home.options ? templateRemotes(template) : null;

      if (shipped !== null && isMap(shipped.value)) {
        // The template's block, with this file's values on it. Its comments are
        // the current documentation; the ones above the old block are not.
        const map = shipped.value;
        if (peers.has('enabled')) map.set('enabled', peers.get('enabled') === true);
        // Off: no realm ever answered a gangpath `@` command before this, so
        // turning it on during a migration would start a behaviour nobody chose.
        map.set('gangpath', false);
        map.set('gang', gang);
        map.set('players', grants);
        automation.items[index] = shipped;
      } else {
        /*
         * A sparse overlay stays sparse, and keeps its own comment: the pair is
         * renamed in place rather than deleted and re-added, so whatever the
         * person wrote above it survives and the block does not move.
         */
        const kept: Record<string, unknown> = {};
        if (peers.has('enabled')) kept['enabled'] = peers.get('enabled') === true;
        if (gang.length > 0) kept['gang'] = gang;
        if (Object.keys(grants).length > 0) kept['players'] = grants;
        const pair = automation.items[index]!;
        (pair.key as Scalar).value = 'remotes';
        pair.value = document.createNode(kept);
      }
      stated.push(file);
      return true;
    });
  }

  if (stated.length === 0) return;
  note(
    stated.length === 1
      ? t('notices.migration.remotes.one', { fileList: stated.join(', ') })
      : t('notices.migration.remotes.many', {
          count: stated.length,
          fileList: stated.join(', ')
        })
  );
  // Said separately because it is the one thing the conversion could not keep,
  // and somebody relying on it needs to know rather than to discover it.
  if (droppedParty) note(t('notices.migration.remotes.partyGroundDropped'));
}

/**
 * `automation.remotes.party`, stated in the options file it governs.
 *
 * The party list ships **non-empty** — two facts about this character's own
 * body — so a file that predates it takes the default and behaves correctly
 * while saying nothing about why. That is the gap this closes:
 * `reconcileWithTemplate` fills an absent *top-level* block and deliberately
 * never reaches inside one, so a key added under `automation:` reaches nobody
 * who has already run the client, and the one grant with anything in it would
 * be the one grant invisible in the file the player reads.
 *
 * **The options file only, and never a profile.** A profile is a sparse
 * overlay: writing the default into one would pin today's list against every
 * later change to it, which is `peersBecameRemotes`' own rule — a key the old
 * block did not state is not stated by the new one — applied to a value rather
 * than to a switch. The character screens write the key when somebody actually
 * chooses something.
 *
 * Nothing changes behaviour: what is written is exactly what
 * `normalizeConfig` was already answering with. What changes is that it is
 * now visible, editable by hand, and carries the paragraph explaining why a
 * permission list ships with anything in it at all.
 */
function statedPartyRemotes(home: Home, note: (message: string) => void): void {
  let stated = false;
  editOptions(home, (document) => {
    const remotes = document.getIn(['automation', 'remotes'], true);
    if (!isMap(remotes)) return false;
    // Already there — a hand-edited file, an empty list somebody pruned on
    // purpose, or a second run of this. Absence is the only thing filled.
    if (remotes.has('party')) return false;

    const pair = document.createPair('party', [...DEFAULT_CONFIG.automation.remotes.party]) as Pair;
    if (isScalar(pair.key)) pair.key.commentBefore = PARTY_REMOTES_COMMENT;
    /*
     * Where the template puts it: after `gang`, before `players`. A migrated
     * file reads as a fresh one, and appending would have put the list after
     * the per-player map, which is the block it falls through *to*.
     */
    const at = remotes.items.findIndex((item) => keyText(item) === 'players');
    if (at === -1) remotes.items.push(pair);
    else remotes.items.splice(at, 0, pair);
    stated = true;
    return true;
  });

  if (stated) note(t('notices.migration.partyRemotesStated', { file: home.options }));
}

/** The template's own words for the list, so the two files read alike. */
const PARTY_REMOTES_COMMENT = ` What anybody who has **joined** this character's party may ask for, and
 the one list that ships with anything in it. The first two names say nothing
 the party listing does not already say and do nothing to this character:
 @health is the absolute figures behind the percentage the listing shows, and
 @bless-expired is a member telling this character their blessing ran out.
 @heal is a member asking for one party heal: nothing while spells.healParty
 is off, and while it is on, one cast per request, no oftener than the heal's
 cooldown and never below minMana.

 @where, @status, @wait and @ok are not on it. The first two name the room
 and the stealth flag, which the listing does not carry; @wait pauses a
 running loop with no deadline. All four are one click away on the Party
 page, by name.

 Membership only -- an invitation nobody accepted is not a party, or
 \`invite\` would be the gesture that hands somebody this list. A \`deny\` on a
 player still beats it.`;

/**
 * The shipped template's `automation.remotes` entry, its comment included.
 *
 * Re-read per file so each one gets its own nodes: a `Pair` assigned into two
 * documents is one node in two trees, and the second write would carry the
 * first file's values.
 */
function templateRemotes(template: string | undefined): Pair | null {
  if (template === undefined || !fs.existsSync(template)) return null;
  let document: Document;
  try {
    document = parseDocument(fs.readFileSync(template, 'utf8'));
  } catch {
    return null;
  }
  if (document.errors.length > 0) return null;
  const automation = document.get('automation', true);
  if (!isMap(automation)) return null;
  return automation.items.find((item) => keyText(item) === 'remotes') ?? null;
}

/** A mapping entry's key as plain text, or null for one that is not a scalar. */
function keyText(pair: Pair): string | null {
  const key = pair.key;
  return isScalar(key) && typeof key.value === 'string' ? key.value : null;
}

/** The strings in a YAML node that may be a list, a scalar, or absent. */
function names(node: unknown): string[] {
  const value = isSeq(node) || isMap(node) ? node.toJSON() : node;
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/** The health thresholds that named a command the client no longer sends. */
const DEAD_HEALTH_KEYS = ['restUntil', 'meditateUntil'] as const;

/**
 * `automation.health.restUntil` and `meditateUntil` go, with the command that
 * read them.
 *
 * Both said *stand the character up at this fraction*, and standing up was
 * `l` — on the belief that any command breaks a rest. A look does not, so on
 * 2026-08-27 a character at full health answered the same status line with the
 * same look 431 times in fourteen seconds. Nothing stands a character up now,
 * because nothing needs to: resting blocks nothing, and moving or attacking
 * ends it without a command being spent (see `HealthConfig`).
 *
 * Unlike the moves above this, a key left behind would not break anything —
 * `normalizeHealth` ignores what it does not know. It is removed anyway,
 * because a value sitting in a file that no screen can edit and no code can
 * read is a setting somebody will one day change and wait to see work.
 *
 * The comments are left exactly as they are, here as everywhere else in this
 * file. Any that describe the old behaviour are now wrong, and rewriting prose
 * somebody may have written themselves is not this code's business.
 */
function dropStandUpThresholds(home: Home, note: (message: string) => void): void {
  const files = [home.options, ...directories(home.profilesDir).map((id) => home.profile(id).file)];
  const cleaned: string[] = [];

  for (const file of files) {
    edit(file, (document) => {
      const health = document.getIn(['automation', 'health'], true);
      if (!isMap(health)) return false;

      const dropped = DEAD_HEALTH_KEYS.filter((key) => health.has(key));
      if (dropped.length === 0) return false;
      for (const key of dropped) health.delete(key);

      // An emptied block reads as a setting somebody meant to fill in, which is
      // the same reason `liftLoops` takes `automation:` with it when it empties.
      if (health.items.length === 0) document.deleteIn(['automation', 'health']);
      cleaned.push(file);
      return true;
    });
  }

  if (cleaned.length === 0) return;
  const params = { count: cleaned.length, fileList: cleaned.join(', ') };
  note(
    cleaned.length === 1
      ? t('notices.migration.restThresholdsDropped.one', params)
      : t('notices.migration.restThresholdsDropped.many', params)
  );
}

/**
 * `ui.showDiagnostics` goes, with the idea that it was a setting at all.
 *
 * The diagnostics cards — Session, Link, Traffic and Stream — are what you open
 * when something looks wrong on the wire: a tool reached for, used and put
 * down. Made configurable, and remembered on top of that, an evening's
 * debugging became the client's permanent shape, and the rail went on paying
 * for it every launch afterwards for somebody who had forgotten they ever
 * asked. They now start hidden every run and the palette toggle lasts only as
 * long as the window.
 *
 * Same reasoning as `dropStandUpThresholds`, and the same shape: a key left
 * behind breaks nothing, because `normalizeConfig` ignores what it does not
 * know — but a value in a file that no screen can edit and no code can read is
 * a setting somebody will one day change and wait to see work. The user's own
 * file said `true`, which is exactly the state this change exists to end.
 *
 * **One comment is rewritten, which is the exception to this file's rule.**
 * Everywhere else here, prose is left exactly as it is: it may be the user's
 * own, and rewriting somebody's notes is not this code's business. The
 * sentence *"Separate from showDiagnostics on purpose"* is not theirs — it is
 * `resources/config/default.yaml`'s own shipped text, copied in at first run,
 * and the same change that removed the key edited it out of the template. Left
 * behind, the user's file teaches a key the client ignores, which
 * `mudengine-config` records as worse than no template at all: they read it,
 * grep for `showDiagnostics`, find nothing, and conclude a setting has gone
 * missing. `reconcileWithTemplate` cannot repair it — by design it never
 * reaches inside a block, so an existing `ui:` never sees the corrected text.
 *
 * It is matched on the shipped wording and only inside `ui:`, so a sentence
 * somebody wrote themselves that happens to mention the word is left alone.
 */
function dropDiagnosticsPreference(home: Home, note: (message: string) => void): void {
  const files = [home.options, ...directories(home.profilesDir).map((id) => home.profile(id).file)];
  const cleaned: string[] = [];

  for (const file of files) {
    edit(file, (document) => {
      const ui = document.getIn(['ui'], true);
      if (!isMap(ui)) return false;

      const hadKey = ui.has('showDiagnostics');
      if (hadKey) {
        ui.delete('showDiagnostics');
        // An emptied block reads as a setting somebody meant to fill in, the
        // same reason the step above deletes `automation.health` when it
        // empties.
        if (ui.items.length === 0) document.delete('ui');
      }
      // The comment can be anywhere in the block: it documents `showHud`, but
      // an earlier edit moved that key and left the paragraph attached to
      // whatever now follows it.
      const rewrote = ui.items.length > 0 && forgetDiagnosticsSentence(ui);

      if (!hadKey && !rewrote) return false;
      cleaned.push(file);
      return true;
    });
  }

  if (cleaned.length === 0) return;
  const params = { count: cleaned.length, fileList: cleaned.join(', ') };
  note(
    cleaned.length === 1
      ? t('notices.migration.diagnosticsPreferenceDropped.one', params)
      : t('notices.migration.diagnosticsPreferenceDropped.many', params)
  );
}

/**
 * A loop copied off the shelf takes the name whoever recorded it gave it.
 *
 * The shelf used to name each loop after the room it starts from, because that
 * is the field `build:loops` read: `Goblin caves: Slime Beast-1 1765`. The
 * recorded file's *first* line carries the title a player typed —
 * `Slime Beast Loop`, `Barren Hills (East Half)` — and that is the name people
 * actually use for these places, so it is what the shelf ships now (todo 98).
 *
 * A loop is addressed by name everywhere in this client, so a file still
 * holding the old spelling is not broken — but it is no longer the shelf's row,
 * which means the Loops modal draws it as a loop of the player's own, the
 * picker's tick beside the shelf row is gone, and choosing that row again files
 * a **second copy** of the same route under the new name. So the files are
 * brought across rather than left to diverge.
 *
 * **Matched on the places, not on the name**, because the name is exactly what
 * changed. A file is renamed only when its stops are, one for one, a shelf
 * loop's stops *and* it is filed under that loop's own area — a loop somebody
 * wrote themselves does not carry `Goblin caves:` in front of it, and the two
 * conditions together are what keeps this off a name a person chose. Two shelf
 * loops with the same places under different names would make the answer a
 * guess, so neither renames anything.
 */
function loopsTookTheirRecordedNames(
  home: Home,
  note: (message: string) => void,
  shelf: (() => readonly Loop[]) | undefined
): void {
  if (shelf === undefined) return;

  const files = [
    home.globalLoops,
    ...directories(home.serversDir).map((id) => home.server(id).loops),
    ...directories(home.profilesDir).map((id) => home.profile(id).loops)
  ].flatMap((dir) =>
    listing(dir)
      .filter((name) => /\.ya?ml$/i.test(name))
      .map((name) => path.join(dir, name))
  );
  // Nothing copied, nothing to bring across — and the shelf stays unread.
  if (files.length === 0) return;

  const byPlaces = new Map<string, Loop | null>();
  for (const loop of shelf()) {
    const key = placesKey(loop);
    byPlaces.set(key, byPlaces.has(key) ? null : loop);
  }

  const renamed: string[] = [];
  for (const file of files) {
    edit(file, (document) => {
      const loop = asLoops([document.toJS() as unknown])[0];
      if (loop === undefined) return false;
      const shelved = byPlaces.get(placesKey(loop));
      if (!shelved || shelved.name === loop.name) return false;
      if (loopCategory(loop.name) !== shelved.category) return false;
      document.set('name', shelved.name);
      renamed.push(`${loop.name} -> ${shelved.name}`);
      return true;
    });
  }

  if (renamed.length === 0) return;
  const params = { count: renamed.length, loopList: renamed.join(', ') };
  note(
    renamed.length === 1
      ? t('notices.migration.loopsRenamed.one', params)
      : t('notices.migration.loopsRenamed.many', params)
  );
}

/**
 * A loop's places as one string, which is its identity while its name moves.
 *
 * The dwell is in the key as well as the room: two loops round the same rooms
 * that wait different lengths at each are two different loops to walk, and a
 * rename that treated them as one would put the wrong name on somebody's file.
 */
function placesKey(loop: Loop): string {
  return JSON.stringify(loop.stops.map((stop) => [stop.room, stop.linger ?? 0]));
}

/**
 * Puts the loop shelf on a toolbar that was pinned before the button existed.
 *
 * `InternalStore` copies its template on first run and never overwrites, which
 * is right — the file is full of the user's own choices — but it means a
 * button added to the shipped row afterwards reaches nobody who has already
 * run the client. Their `toolbar.pinned` still lists the row as it was, so the
 * one way in to four hundred and twenty loops would be a kebab at the end of a
 * row nobody opens: precisely the failure this project has a name for, and the
 * reason the pre-v1 rule says a change to a shipped default is a change to
 * what is on disk.
 *
 * Added **after `loot`**, where the shipped row puts it, so the row a migrated
 * client draws is the row a fresh one draws. Appending would have been simpler
 * and would have put the shelf on the far side of the transport controls,
 * which is a different toolbar.
 *
 * Nothing else is touched, and a file that has already been curated to drop
 * `loot` still gets the button — at the front, where it is at least present.
 * A user who has deliberately unpinned it says so in `localStorage`, which is
 * where a deviation from the shipped row lives (`useToolbarPins`) and which
 * this cannot and must not reach.
 */
function pinTheLoopShelf(home: Home, note: (message: string) => void): void {
  let pinned = false;
  edit(home.internal, (document) => {
    const list = document.getIn(['toolbar', 'pinned'], true);
    if (!isSeq(list)) return false;

    const ids = list.items.map((item) => (isScalar(item) ? String(item.value) : null));
    // Already there — a file edited by hand, or a second run of this.
    if (ids.includes('loop:open')) return false;

    const after = ids.indexOf('loot');
    const at = after >= 0 ? after + 1 : 0;
    list.items.splice(at, 0, new Scalar('loop:open'));
    pinned = true;
    return true;
  });

  if (pinned) note(t('notices.migration.loopShelfPinned'));
}

/** The shipped sentence, as `default.yaml` used to state it. */
const DIAGNOSTICS_SENTENCE =
  /[ \t]*Separate from showDiagnostics on purpose: the HUD is what you read while\n[ \t]*playing, and it appears on its own without opening a panel named after\n[ \t]*something else\. /;

/**
 * Takes the retired sentence out of whichever comment in `ui:` carries it.
 *
 * The rest of the paragraph still says something true — the HUD appears on its
 * own and is toggled from the palette — so only the clause naming the dead key
 * goes, and the sentence after it is left to open the paragraph.
 */
function forgetDiagnosticsSentence(ui: YAMLMap): boolean {
  /*
   * The block node itself comes first, and that is not an afterthought: a
   * comment standing before the block's *first* key is stored on the map
   * rather than on any item, so a file that still states `showHud` at the top
   * of `ui:` — which is how the template ships it — keeps the sentence
   * somewhere that walking the items alone never looks. The user's own file
   * has it on an item instead, because an earlier edit moved `showHud` to the
   * bottom of the block and left the paragraph attached to whatever now
   * follows it. Both placements are real; both are swept.
   */
  const nodes: { commentBefore?: string | null }[] = [ui];
  for (const item of ui.items) {
    for (const node of [item.key, item.value]) {
      if (isScalar(node) || isMap(node) || isSeq(node)) nodes.push(node);
    }
  }

  let rewrote = false;
  for (const node of nodes) {
    const before = node.commentBefore;
    if (typeof before !== 'string' || !DIAGNOSTICS_SENTENCE.test(before)) continue;
    // One space back: the pattern eats the comment line's own leading space,
    // and `yaml` writes `#` straight onto whatever follows it.
    node.commentBefore = before.replace(DIAGNOSTICS_SENTENCE, ' ');
    rewrote = true;
  }
  return rewrote;
}

/**
 * Moves an options file from wherever it used to live, and everything beside it.
 *
 * Only when there is no options file in the new place — with one there, this
 * client has already been run and an older file elsewhere is a leftover, not
 * the truth. The records beside it come too, because they are keyed to the
 * characters in it: a world memory left behind is a character that has
 * forgotten every corridor it found.
 */
function adoptLegacyRoot({ home, legacyOptions, keep, note }: MigrationOptions): void {
  if (fs.existsSync(home.options)) return;

  const found = legacyOptions.find((candidate) => candidate.length > 0 && fs.existsSync(candidate));
  if (!found) return;

  const from = path.dirname(found);
  const protectedFiles = new Set((keep ?? []).map((file) => path.resolve(file)));
  const movable = (file: string): boolean => !protectedFiles.has(path.resolve(file));
  fs.mkdirSync(home.globalDir, { recursive: true });
  move(found, home.options);
  note(t('notices.migration.optionsMoved', { from: found, to: home.options }));
  // The backup belongs with the file it is a backup of, or the next save
  // would write a second one and the first would be orphaned under a name
  // nothing looks for.
  move(`${found}.bak`, `${home.options}.bak`);

  const oldProfiles = path.join(from, 'profiles');
  if (fs.existsSync(oldProfiles) && !fs.existsSync(home.profilesDir)) {
    move(oldProfiles, home.profilesDir);
    note(t('notices.migration.charactersMoved', { from: oldProfiles, to: home.profilesDir }));
  }

  for (const name of STATE) {
    move(path.join(from, name), home.state(name));
  }
  for (const name of STATE_FILES) {
    const file = path.join(from, name);
    if (movable(file)) move(file, home.state(name));
  }
}

/**
 * `profiles/<id>.yaml` becomes `profiles/<id>/profile.yaml`.
 *
 * A character owns loops now, and a file cannot contain a directory. The id —
 * which names the session, the log, the capture and the tab — is unchanged: it
 * was the filename and it is now the directory's name.
 */
function foldProfilesIntoDirectories(home: Home, note: (message: string) => void): void {
  let moved = 0;
  for (const name of listing(home.profilesDir)) {
    if (!/\.ya?ml$/i.test(name) || name.startsWith('.')) continue;
    const id = name.replace(/\.ya?ml$/i, '');
    const scope = home.profile(id);
    if (fs.existsSync(scope.file)) continue;
    fs.mkdirSync(scope.dir, { recursive: true });
    move(path.join(home.profilesDir, name), scope.file);
    move(path.join(home.profilesDir, `${name}.bak`), `${scope.file}.bak`);
    moved += 1;
  }
  if (moved > 0) {
    note(
      moved === 1
        ? t('notices.migration.profilesFolded.one', { count: moved })
        : t('notices.migration.profilesFolded.many', { count: moved })
    );
  }
}

/** `servers:` in the options file becomes one directory per server. */
function liftServersOutOfOptions(home: Home, note: (message: string) => void): void {
  editOptions(home, (document) => {
    const list = document.get('servers', true);
    if (!isSeq(list) || list.items.length === 0) return false;

    const taken = new Set(listing(home.serversDir));
    let written = 0;
    let lead = leadFor(document, ['servers'], list.commentBefore);

    for (const entry of list.items) {
      if (!isMap(entry)) continue;
      const named = entry.get('name');
      const host = entry.get('host');
      if (typeof host !== 'string' || host.length === 0) continue;
      const id = fileSlug(typeof named === 'string' && named.length > 0 ? named : host, taken);
      taken.add(id);
      const scope = home.server(id);
      if (fs.existsSync(scope.file)) continue;
      fs.mkdirSync(scope.dir, { recursive: true });
      fs.writeFileSync(scope.file, header(SERVER_HEADER) + stringify(entry as Node, lead), 'utf8');
      lead = null;
      written += 1;
    }

    if (written === 0) return false;
    document.delete('servers');
    const params = { count: written, serversDir: home.serversDir };
    note(
      written === 1
        ? t('notices.migration.serversLifted.one', params)
        : t('notices.migration.serversLifted.many', params)
    );
    return true;
  });
}

/** `automation.loops` in the options file becomes `global/loops/*.yaml`. */
function liftLoopsOutOfOptions(home: Home, note: (message: string) => void): void {
  editOptions(home, (document) => {
    const written = liftLoops(document, home.globalLoops);
    if (written === 0) return false;
    const params = { count: written, globalLoopsDir: home.globalLoops };
    note(
      written === 1
        ? t('notices.migration.globalLoopsLifted.one', params)
        : t('notices.migration.globalLoopsLifted.many', params)
    );
    return true;
  });
}

/** Each character's own `automation.loops` becomes `profiles/<id>/loops/*.yaml`. */
function liftLoopsOutOfProfiles(home: Home, note: (message: string) => void): void {
  for (const id of directories(home.profilesDir)) {
    const scope = home.profile(id);
    if (!fs.existsSync(scope.file)) continue;
    edit(scope.file, (document) => {
      const written = liftLoops(document, scope.loops);
      if (written === 0) return false;
      const params = { count: written, characterId: id, loopsDir: scope.loops };
      note(
        written === 1
          ? t('notices.migration.profileLoopsLifted.one', params)
          : t('notices.migration.profileLoopsLifted.many', params)
      );
      return true;
    });
  }
}

/**
 * Moves every entry of `automation.loops` into a directory, one file each.
 *
 * Returns how many were written, and deletes the key — and the `automation:`
 * map with it when nothing else was in there, because an empty block left
 * behind reads as a setting somebody meant to fill in.
 */
function liftLoops(document: Document, into: string): number {
  const list = document.getIn(['automation', 'loops'], true);
  if (!isSeq(list) || list.items.length === 0) return 0;

  const taken = new Set(listing(into).map((name) => name.replace(/\.ya?ml$/i, '')));
  let written = 0;
  let lead = leadFor(document, ['automation', 'loops'], list.commentBefore);

  for (const entry of list.items) {
    if (!isMap(entry)) continue;
    const named = entry.get('name');
    const name = typeof named === 'string' && named.trim().length > 0 ? named.trim() : '';
    if (name.length === 0) continue;
    const slug = fileSlug(name, taken);
    taken.add(slug);
    const file = path.join(into, `${slug}.yaml`);
    if (fs.existsSync(file)) continue;
    fs.mkdirSync(into, { recursive: true });
    fs.writeFileSync(file, header(LOOP_HEADER) + stringify(entry as Node, lead), 'utf8');
    lead = null;
    written += 1;
  }

  if (written === 0) return 0;
  document.deleteIn(['automation', 'loops']);
  const automation = document.get('automation', true);
  if (isMap(automation) && automation.items.length === 0) document.delete('automation');
  return written;
}

const SERVER_HEADER = `A server, moved here out of the \`servers:\` list in the options file.
Everything about one BBS or realm lives in its own directory now, so it can
carry the loops that belong to the place rather than to a character:
\`loops/*.yaml\` beside this file is walkable by everyone who plays here.`;

const LOOP_HEADER = `A loop: the list of places a character walks round and round.

Which characters may walk it is decided by where this file is, and nothing
inside it — \`global/loops\` is everybody, \`servers/<id>/loops\` is everybody
on that server, \`profiles/<id>/loops\` is one character.`;

/**
 * The comment that belongs to a block, wherever `yaml` filed it.
 *
 * A note written above `loops:` attaches to the **key** of that pair; one
 * written above the first `- name:` under it attaches to the **sequence**. They
 * look the same in the file and they are the same thing to whoever wrote them,
 * so both are carried onto the first file the block becomes. Losing either
 * would be losing the sentence that says why a loop exists — and in this repo
 * the comments are the documentation.
 */
function leadFor(
  document: Document,
  at: string[],
  fromSeq: string | null | undefined
): string | null {
  const parent = at.length === 1 ? document.contents : document.getIn(at.slice(0, -1), true);
  const key = at[at.length - 1];
  let fromKey: string | null = null;

  if (isMap(parent)) {
    const index = parent.items.findIndex((item) => isScalar(item.key) && item.key.value === key);
    const pair = index === -1 ? undefined : parent.items[index];
    /*
     * A comment above the *first* key of a map is filed on the map rather than
     * on the key — so where it lands depends on whether the block happens to be
     * first in its parent, which is not a distinction anybody writing the file
     * made. Taken from whichever place holds it, and cleared, so it does not
     * dangle over whatever follows once the key is gone.
     */
    if (pair && isScalar(pair.key) && pair.key.commentBefore) {
      fromKey = pair.key.commentBefore;
      pair.key.commentBefore = null;
    } else if (index === 0 && parent.commentBefore) {
      fromKey = parent.commentBefore;
      parent.commentBefore = null;
    }
  }
  const parts = [fromKey, fromSeq ?? null].filter(
    (part): part is string => !!part && part.length > 0
  );
  return parts.length > 0 ? parts.join('\n') : null;
}

function header(text: string): string {
  return `${text
    .split('\n')
    .map((line) => (line.length > 0 ? `# ${line}` : '#'))
    .join('\n')}\n\n`;
}

/**
 * One node as a document of its own, comments and all.
 *
 * `lead` is the comment that sat above the *list*, which `yaml` attaches to the
 * sequence rather than to its first item — so a note somebody wrote above the
 * first server would be the one comment in the block that this lost. It goes
 * above the first file written and nowhere else.
 */
function stringify(node: Node, lead?: string | null): string {
  const document = new Document(node);
  if (lead !== undefined && lead !== null && lead.length > 0) document.commentBefore = lead;
  return String(document);
}

/**
 * Applies a change to the options file, if the change says there was one.
 *
 * A rolling backup first, like every other edit to a file the user owns, and a
 * refusal rather than a rewrite when the file does not parse: it is somebody's
 * only copy, and a document rebuilt from the parts that did parse discards the
 * rest without asking.
 */
const AUTO_RECONNECT_COMMENT = ` Dial this character again when a connection is LOST -- a link that dropped,
 a server that went away. On by default, and not the same question as the one
 above: that one opens a connection you did not ask for, this one puts back
 the one you had.

 It never fires for a disconnect you asked for -- pressing Disconnect, hanging
 up on low health, dialling a second realm, quitting -- and never once you have
 typed your way out to the menu. The waits are 0s, 5s, 10s and then 15s for as
 long as it takes; \`tuning.reconnect\` in internal.yaml is where those live.`;

/**
 * `autoReconnect`, stated in every character's own file.
 *
 * Nothing about how the client behaves changes: the key is read as *on* when
 * it is absent, which is the one direction a default is read that way here.
 * What changes is that the file says so — and a character's file is the surface
 * half the people who use this client edit by hand, so a setting that exists
 * only in a form and in a template they copied once is the invisible-setting
 * failure with the settings screen papering over it.
 *
 * **Profiles only.** It is a property of a character, like `autoConnect` beside
 * which it is written; the options file has no `autoReconnect` to state, and
 * putting one there would be a second spelling of a setting the screen could
 * not keep honest.
 *
 * Idempotent for the reason `statedDoorForcing` is and `pinTheGearButton` is
 * not: this is a key in a map, so somebody who sets it to `false` keeps that
 * — a key stays added whatever its value. Nothing stated is overwritten.
 */
/**
 * Automatic lighting and the supplies list, 2026-09-03.
 *
 * Three keys into every `automation.movement` block that lacks them, with the
 * template's own paragraph, so `provideLight` — the one automated thing that
 * is on by default — is *visible* in a file that predates it rather than
 * silently applied from the built-in default; and a `supplies:` block into
 * the options file's `automation:` map, for `reconcileWithTemplate`'s reason:
 * it copies whole missing top-level blocks and never reaches inside one.
 * Character files are left to inherit it; the Self card writes a list into
 * one the moment somebody adds an item.
 *
 * The key-into-a-map shape, so it is idempotent against a user who has since
 * set any of them to `false` — see `statedDoorForcing`.
 */
function statedTheLightAndSupplies(home: Home, note: (message: string) => void): void {
  const files = [home.options, ...directories(home.profilesDir).map((id) => home.profile(id).file)];
  const stated: string[] = [];

  for (const file of files) {
    edit(file, (document) => {
      const movement = document.getIn(['automation', 'movement'], true);
      if (!isMap(movement)) return false;

      let changed = false;
      let first: Pair | null = null;
      for (const [key, value] of LIGHT_DEFAULTS) {
        if (movement.has(key)) continue;
        const pair = document.createPair(key, value) as Pair;
        movement.items.push(pair);
        if (first === null) first = pair;
        changed = true;
      }
      if (!changed) return false;
      if (first !== null && isScalar(first.key)) first.key.commentBefore = LIGHT_COMMENT;
      stated.push(file);
      return true;
    });
  }

  let supplied = false;
  edit(home.options, (document) => {
    const automation = document.getIn(['automation'], true);
    if (!isMap(automation) || automation.has('supplies')) return false;
    const pair = document.createPair('supplies', { enabled: true, items: [] }) as Pair;
    if (isScalar(pair.key)) pair.key.commentBefore = SUPPLIES_COMMENT;
    automation.items.push(pair);
    supplied = true;
    return true;
  });

  if (stated.length > 0) {
    const params = { count: stated.length, fileList: stated.join(', ') };
    note(
      stated.length === 1
        ? t('notices.migration.lightStated.one', params)
        : t('notices.migration.lightStated.many', params)
    );
  }
  if (supplied) note(t('notices.migration.suppliesStated', { file: home.options }));
}

/**
 * Waiting a stated condition out, 2026-09-05 — and the file that never got it.
 *
 * `walkWhileBlind` and `walkWhilePoisoned` reached the type, the shipped
 * template, both readers (`afflictionHolding`, for the walker within a leg and
 * the loop between them) and both settings pages on the day they were added,
 * and reached **nobody's own options file**, because
 * `reconcileWithTemplate` copies a whole absent top-level block and
 * deliberately never reaches inside one. `normalizeConfig` still applies the
 * default, so a route standing still while the character is blind is correct
 * behaviour — and a player looking for the switch that changes it finds
 * `automation.movement` ending at `extinguishInLight`, with nothing in the
 * file to say the wait is a choice at all. That is the invisible-setting
 * failure `statedDoorForcing` and `statedTheLightAndSupplies` were each
 * written for, one pair of keys along.
 *
 * The template's own paragraph goes with them, because here the comments are
 * the documentation, and it is the half that says what the defaults refuse to
 * do: paralysis always holds, and disease is left to the cure.
 *
 * The key-into-a-map shape, so it is idempotent against somebody who has since
 * set either to `true` — a key stays added whatever its value. Nothing stated
 * is overwritten.
 */
function statedTheConditionWaits(home: Home, note: (message: string) => void): void {
  const files = [home.options, ...directories(home.profilesDir).map((id) => home.profile(id).file)];
  const stated: string[] = [];

  for (const file of files) {
    edit(file, (document) => {
      const movement = document.getIn(['automation', 'movement'], true);
      if (!isMap(movement)) return false;

      let changed = false;
      let first: Pair | null = null;
      for (const [key, value] of CONDITION_WAIT_DEFAULTS) {
        if (movement.has(key)) continue;
        const pair = document.createPair(key, value) as Pair;
        movement.items.push(pair);
        if (first === null) first = pair;
        changed = true;
      }
      if (!changed) return false;
      if (first !== null && isScalar(first.key)) first.key.commentBefore = CONDITION_WAIT_COMMENT;
      stated.push(file);
      return true;
    });
  }

  if (stated.length === 0) return;
  const params = { count: stated.length, fileList: stated.join(', ') };
  note(
    stated.length === 1
      ? t('notices.migration.conditionWaitsStated.one', params)
      : t('notices.migration.conditionWaitsStated.many', params)
  );
}

/**
 * Bending down for a key an exit here needs, 2026-09-06 (todo 01).
 *
 * `collectKeys` ships on, so a file that predates it works correctly from the
 * built-in default and says nothing about it — which is the invisible-setting
 * failure `statedTheLightAndSupplies` and `statedTheConditionWaits` were each
 * written for, one key along. `reconcileWithTemplate` copies a whole absent
 * top-level block and deliberately never reaches inside one, so
 * `automation.movement` in somebody's own file would go on ending at
 * `walkWhilePoisoned` while the client picked keys up.
 *
 * The template's own paragraph goes with it, because here the comments are the
 * documentation and this one's substance is the *narrowness*: what it will not
 * do is the half somebody deciding whether to leave it on needs.
 *
 * The key-into-a-map shape, so it is idempotent against somebody who has since
 * set it to `false` — a key stays added whatever its value. Nothing stated is
 * overwritten.
 */
function statedTheKeyPickup(home: Home, note: (message: string) => void): void {
  const files = [home.options, ...directories(home.profilesDir).map((id) => home.profile(id).file)];
  const stated: string[] = [];

  for (const file of files) {
    edit(file, (document) => {
      const movement = document.getIn(['automation', 'movement'], true);
      if (!isMap(movement)) return false;

      let changed = false;
      let first: Pair | null = null;
      for (const [key, value] of KEY_PICKUP_DEFAULTS) {
        if (movement.has(key)) continue;
        const pair = document.createPair(key, value) as Pair;
        movement.items.push(pair);
        if (first === null) first = pair;
        changed = true;
      }
      if (!changed) return false;
      if (first !== null && isScalar(first.key)) first.key.commentBefore = KEY_PICKUP_COMMENT;
      stated.push(file);
      return true;
    });
  }

  if (stated.length === 0) return;
  const params = { count: stated.length, fileList: stated.join(', ') };
  note(
    stated.length === 1
      ? t('notices.migration.keyPickupStated.one', params)
      : t('notices.migration.keyPickupStated.many', params)
  );
}

function statedAutoReconnect(home: Home, note: (message: string) => void): void {
  const stated: string[] = [];

  for (const id of directories(home.profilesDir)) {
    const file = home.profile(id).file;
    edit(file, (document) => {
      const root = document.contents;
      if (!isMap(root) || root.has('autoReconnect')) return false;

      const pair = document.createPair('autoReconnect', true) as Pair;
      if (isScalar(pair.key)) pair.key.commentBefore = AUTO_RECONNECT_COMMENT;
      // Beside the setting it is most easily confused with, so a file that
      // gains it reads like the shipped template rather than like a patch.
      const after = root.items.findIndex(
        (item) => isScalar(item.key) && item.key.value === 'autoConnect'
      );
      if (after === -1) root.items.push(pair);
      else root.items.splice(after + 1, 0, pair);

      stated.push(file);
      return true;
    });
  }

  if (stated.length === 0) return;
  const params = { count: stated.length, fileList: stated.join(', ') };
  note(
    stated.length === 1
      ? t('notices.migration.autoReconnectStated.one', params)
      : t('notices.migration.autoReconnectStated.many', params)
  );
}

/**
 * The `tuning:` keys added and retired on 2026-09-03, in the user's own
 * `internal.yaml`.
 *
 * `reconcileWithTemplate` fills in a whole absent **top-level** block and
 * deliberately never reaches inside one, so a key added under `tuning:`
 * afterwards reaches nobody who has already run the client — which for this
 * file is everybody, because `tuning:` has been there since the block existed.
 * The defaults still apply, so nothing behaves wrongly; what is wrong is that
 * `internal.yaml` is the file whose entire purpose is *"when one of these needs
 * changing you can fix it without waiting for a release"*, and four numbers
 * that cannot be found in it are four numbers nobody can change.
 *
 * Checked against this machine's own file before it was written: 557 lines,
 * `tuning:` with eighteen sub-blocks, no `reconnect:`, and `parse:` with no
 * `staleMoveMs` beside `maxPendingMoves`.
 *
 * `theLoopSettlesAfterAnEscape` is the precedent for reaching in here at all,
 * including taking the prose from the shipped template rather than restating
 * it — the template is the documentation, and a paragraph copied by hand is a
 * second copy to keep in step.
 *
 * The two **retired** keys go the same way `dropDiagnosticsPreference` and
 * `dropTheRoundMacro` take theirs: `normalizeInternal` ignores a key it does
 * not know, so one left behind is a number somebody tunes and then waits to
 * see work.
 */
function theTuningBlockGainedKeys(
  home: Home,
  note: (message: string) => void,
  template: string | undefined
): void {
  const comments = templateComments(template, 'tuning');
  const added: string[] = [];
  const removed: string[] = [];

  edit(home.internal, (document) => {
    const tuning = document.getIn(['tuning'], true);
    if (!isMap(tuning)) return false;
    let changed = false;

    /**
     * A whole group, with the comment the template gives it and each of its
     * keys. Written only where `tuning:` itself is stated, which is the same
     * test `reconcileWithTemplate` makes one level up — and the defaults
     * themselves, never a copy of them, so the group cannot drift from the
     * constant the file documents.
     */
    const addGroup = (name: string, values: Record<string, number | boolean>): void => {
      if (tuning.items.some((item) => keyText(item) === name)) return;
      const group = document.createNode(values);
      const pair = document.createPair(name, group) as Pair;
      const lead = comments.get(`tuning.${name}`);
      if (typeof lead === 'string' && isScalar(pair.key)) pair.key.commentBefore = lead;
      if (isMap(group)) {
        for (const inner of group.items) {
          const key = keyText(inner);
          const comment = key === null ? undefined : comments.get(`tuning.${name}.${key}`);
          if (typeof comment === 'string' && isScalar(inner.key)) {
            inner.key.commentBefore = comment;
          }
        }
      }
      tuning.items.push(pair);
      added.push(`tuning.${name}`);
      changed = true;
    };

    addGroup('reconnect', {
      stepMs: DEFAULT_INTERNAL.tuning.reconnect.stepMs,
      maxDelayMs: DEFAULT_INTERNAL.tuning.reconnect.maxDelayMs,
      maxAttempts: DEFAULT_INTERNAL.tuning.reconnect.maxAttempts,
      maxFlaps: DEFAULT_INTERNAL.tuning.reconnect.maxFlaps,
      settledMs: DEFAULT_INTERNAL.tuning.reconnect.settledMs
    });
    // How auto-combat prices a monster's hazards (2026-09-04): a group with
    // nothing to read it in a file copied before it existed would be the
    // setting somebody edits and then waits to see work.
    addGroup('menace', { ...DEFAULT_INTERNAL.tuning.menace });
    // The shadows between fights (todo 01) and where to hunt (todo 05),
    // 2026-09-12: two groups a file copied before them would otherwise lack.
    addGroup('stealth', { ...DEFAULT_INTERNAL.tuning.stealth });
    addGroup('hunting', { ...DEFAULT_INTERNAL.tuning.hunting });
    addGroup('gearRecovery', { ...DEFAULT_INTERNAL.tuning.gearRecovery });
    // The stat screen driver (todo 10, 2026-09-12).
    addGroup('train', { ...DEFAULT_INTERNAL.tuning.train });
    // The quest runner's own clocks (2026-09-21, todos 102-103): every wait it
    // makes is bounded by one of these, so a run that looks stuck is diagnosed
    // from this block or not at all.
    addGroup('quests', { ...DEFAULT_INTERNAL.tuning.quests });

    /** One key into a sub-block the file already states, with its paragraph. */
    const addKey = (group: string, key: string, value: number): void => {
      const block = document.getIn(['tuning', group], true);
      if (!isMap(block) || block.items.some((item) => keyText(item) === key)) return;
      const pair = document.createPair(key, value) as Pair;
      const comment = comments.get(`tuning.${group}.${key}`);
      if (typeof comment === 'string' && isScalar(pair.key)) pair.key.commentBefore = comment;
      block.items.push(pair);
      added.push(`tuning.${group}.${key}`);
      changed = true;
    };

    addKey('parse', 'staleMoveMs', DEFAULT_INTERNAL.tuning.parse.staleMoveMs);
    addKey('view', 'rateFloorMs', DEFAULT_INTERNAL.tuning.view.rateFloorMs);
    /*
     * The slide-out panels' own bounds (2026-09-05, todo 03). The two widths
     * are the ones that matter most: the whole complaint was that a fixed
     * 300px panel is wrong for somebody's screen, and the numbers they would
     * reach for would otherwise be absent from the file they would open.
     */
    addKey('view', 'popoverWidthMin', DEFAULT_INTERNAL.tuning.view.popoverWidthMin);
    addKey('view', 'popoverWidthMax', DEFAULT_INTERNAL.tuning.view.popoverWidthMax);
    addKey('view', 'popoverMinHeight', DEFAULT_INTERNAL.tuning.view.popoverMinHeight);
    /* The debug window's two bounds (todo 05): main's ring, and the window's. */
    addKey('session', 'debugLogLimit', DEFAULT_INTERNAL.tuning.session.debugLogLimit);
    addKey('view', 'debugRows', DEFAULT_INTERNAL.tuning.view.debugRows);
    /* What a step on a saved route costs (2026-09-05, the loop builder). */
    addKey('world', 'preferredStepCost', DEFAULT_INTERNAL.tuning.world.preferredStepCost);
    /* The wheel on a map: how much a notch zooms, and when the card writes it down. */
    addKey('view', 'mapZoomStepPercent', DEFAULT_INTERNAL.tuning.view.mapZoomStepPercent);
    addKey('view', 'mapZoomSettleMs', DEFAULT_INTERNAL.tuning.view.mapZoomSettleMs);
    /*
     * The Hunting card's re-ask clock (todo 00, 2026-09-13), which took the
     * place of its reach: the sweep is realm-wide now, so a move refreshes
     * the steps on a clock rather than re-sweeping a radius on every room.
     */
    addKey('view', 'huntReaskMs', DEFAULT_INTERNAL.tuning.view.huntReaskMs);
    /* Snapping one card over the console to another (todo 02, 2026-09-13). */
    addKey('view', 'snapDistance', DEFAULT_INTERNAL.tuning.view.snapDistance);
    /*
     * And what the survey leaves out and measures (the same todo): the two
     * exclusions, the margin the beneath-this-level test reads the bar at,
     * and the two sweeps a loop's ring and its fillers are measured with.
     */
    addKey('hunting', 'maxDamageShare', DEFAULT_INTERNAL.tuning.hunting.maxDamageShare);
    addKey('hunting', 'trivialShare', DEFAULT_INTERNAL.tuning.hunting.trivialShare);
    addKey('hunting', 'trivialLevelMargin', DEFAULT_INTERNAL.tuning.hunting.trivialLevelMargin);
    addKey('hunting', 'clusterRadius', DEFAULT_INTERNAL.tuning.hunting.clusterRadius);
    addKey('hunting', 'fillerRadius', DEFAULT_INTERNAL.tuning.hunting.fillerRadius);
    addKey('hunting', 'sizeTolerance', DEFAULT_INTERNAL.tuning.hunting.sizeTolerance);
    /* A lair's clock and the look next door (2026-09-12, todo 08). */
    addKey('rest', 'lairClockMaxSeconds', DEFAULT_INTERNAL.tuning.rest.lairClockMaxSeconds);
    addKey('rest', 'peekMs', DEFAULT_INTERNAL.tuning.rest.peekMs);
    /* How sure a kill must be before the cheapest spell wins (2026-09-12, todo 09). */
    addKey('spells', 'killConfidence', DEFAULT_INTERNAL.tuning.spells.killConfidence);
    /*
     * How long a command the realm threw away waits before it goes again
     * (2026-09-06, todo 02) — the server's own 1,000ms fumble delay.
     */
    addKey('queue', 'fumbleRetryMs', DEFAULT_INTERNAL.tuning.queue.fumbleRetryMs);
    /*
     * And the two that replace `walk.searchTries` below (todo 04): the beat
     * between two searches for a hidden exit, which is now unbounded, and the
     * count a lever exit still keeps. Added beside the drop rather than in a
     * migration of their own, so somebody who opens the file looking for the
     * retired number finds what took its place in the same paragraph.
     */
    addKey('walk', 'searchRetryMs', DEFAULT_INTERNAL.tuning.walk.searchRetryMs);
    addKey('walk', 'searchSayEveryMs', DEFAULT_INTERNAL.tuning.walk.searchSayEveryMs);
    /*
     * How often a walk that is searching asks the server to reprint the room
     * (2026-09-06, todo 03). `You found an exit to the south!` does not reprint
     * it, so the walk went on searching a room whose exit it had already found;
     * a success always asks now, and a failure every this many. In the
     * template's own order — a file somebody opens should read the way the
     * documentation they are comparing it against does.
     */
    addKey('walk', 'searchRecheckEvery', DEFAULT_INTERNAL.tuning.walk.searchRecheckEvery);
    addKey('walk', 'leverTries', DEFAULT_INTERNAL.tuning.walk.leverTries);
    /*
     * How long a command may go unanswered before the link is called dead
     * (2026-09-07, todo 00). It is the only number that decides whether a
     * connection that died quietly is ever noticed, so a file that cannot
     * state it is a file in which the feature cannot be turned off.
     */
    addKey('reconnect', 'silentForMs', DEFAULT_INTERNAL.tuning.reconnect.silentForMs);
    /* How much of a realm's find log is kept (2026-09-07, todo 04). */
    addKey('records', 'findLimit', DEFAULT_INTERNAL.tuning.records.findLimit);
    /* When a character stops looking like the same character (todo 11). */
    addKey('session', 'resetExpDropShare', DEFAULT_INTERNAL.tuning.session.resetExpDropShare);
    /* A prompt the server writes in two pieces (2026-09-10, todo 01): how long the second may take. */
    addKey('session', 'promptHoldMs', DEFAULT_INTERNAL.tuning.session.promptHoldMs);
    /* And how long a tail that is not a prompt waits for the rest of itself
       (2026-09-17): the quiet period is a prompt's, and 150ms of internet is
       not an ended sentence. In the template's own order, beside it. */
    addKey('session', 'sentenceHoldMs', DEFAULT_INTERNAL.tuning.session.sentenceHoldMs);
    /* How long a listing the client redraws waits for its prompt (2026-09-10, todo 99). */
    addKey('session', 'rewriteHoldMs', DEFAULT_INTERNAL.tuning.session.rewriteHoldMs);
    /* The look queue's floor and its shelf life (2026-09-07, todo 10). */
    addKey('queue', 'lookAskMs', DEFAULT_INTERNAL.tuning.queue.lookAskMs);
    addKey('queue', 'lookExpiresMs', DEFAULT_INTERNAL.tuning.queue.lookExpiresMs);
    /* What a room's own spell costs, and when the router looks for another way
       (2026-09-09, todo 01), and how much shorter the way with the right items
       has to be to be offered (2026-09-10, todo 01). */
    addKey('world', 'unreadHazardShare', DEFAULT_INTERNAL.tuning.world.unreadHazardShare);
    addKey('world', 'otherWayShare', DEFAULT_INTERNAL.tuning.world.otherWayShare);
    addKey('world', 'alternativeMinSteps', DEFAULT_INTERNAL.tuning.world.alternativeMinSteps);
    /* The Talk card's recall and the room quick view's dwell (2026-09-09/10). */
    addKey('view', 'talkHistoryLimit', DEFAULT_INTERNAL.tuning.view.talkHistoryLimit);
    addKey('view', 'roomPeekDelayMs', DEFAULT_INTERNAL.tuning.view.roomPeekDelayMs);
    addKey('view', 'roomPeekLingerMs', DEFAULT_INTERNAL.tuning.view.roomPeekLingerMs);
    /*
     * How long the Talk card holds its place after a scroll (2026-09-08). The
     * hold is the whole point of the feature and the expiry is the whole point
     * of the hold, so a file that cannot state the number is a file in which
     * neither can be tuned to how fast somebody reads.
     */
    addKey('view', 'talkFollowResumeMs', DEFAULT_INTERNAL.tuning.view.talkFollowResumeMs);
    /*
     * How long a desktop notification's kind rests before it may speak again
     * about the same character (2026-09-10, todo 01). It is the number that
     * decides whether an evening away leaves one notification or three
     * hundred, so a file that cannot state it is a file in which the feature
     * cannot be made bearable.
     */
    addKey('view', 'desktopAlertGapMs', DEFAULT_INTERNAL.tuning.view.desktopAlertGapMs);
    /*
     * What the quest book's errand solver will weigh (2026-09-15, todo 01):
     * how many of a step's items it puts in order, how many places for each,
     * and how far one of its sweeps may go. The first two are the exponent
     * and the base of an exact solve, so they are the two numbers somebody
     * whose realm holds a step bigger than either shipped world's would reach
     * for — and a file that cannot state them is a file in which the order
     * cannot be made to cover their realm.
     */
    addKey('world', 'errandItems', DEFAULT_INTERNAL.tuning.world.errandItems);
    addKey('world', 'errandPlaces', DEFAULT_INTERNAL.tuning.world.errandPlaces);
    addKey('world', 'errandSweepRooms', DEFAULT_INTERNAL.tuning.world.errandSweepRooms);
    /*
     * The follow window (2026-09-23): how long a walk stands in the room it
     * has arrived in before stepping out again, where the room behind held a
     * monster. It is the one number that decides whether a lap drags whatever
     * was chasing it through the next four rooms, and the sort of number
     * somebody who plays a realm with different pacing would want to raise.
     */
    addKey('walk', 'followSettleMs', DEFAULT_INTERNAL.tuning.walk.followSettleMs);
    /*
     * And the eight this file had fallen behind by (2026-09-23, on review).
     *
     * Every one of them is stated in the shipped template and reachable from
     * `TUNING_DEFAULTS`, so nothing behaved wrongly — but `reconcileWithTemplate`
     * fills in an absent *top-level* block and never reaches inside `tuning:`,
     * which every file that has ever run this client states. So they were eight
     * numbers documented in a file nobody's copy contained, which is the whole
     * of what `internal.yaml` exists not to be.
     *
     * A member's `@heal` request and how often this character asks for one
     * (2026-09-19); the fights a lair's own measured rate needs before it
     * outranks the prediction; the quest runner's whole clock block and its
     * banner's linger (2026-09-21, todos 102-103); the two figures that price a
     * second way to somewhere and the count of stoppers a hazard's supplies buy.
     */
    /*
     * **The group first, because `addKey` only fills a block the file already
     * states.** Measured against this machine's own `internal.yaml`: 24 groups,
     * and `remotes:` is not one of them — so `addKey('remotes', …)` alone would
     * have been a second migration that reached nobody, for the same reason as
     * the first. `addGroup` returns early where the block is there, so the pair
     * is *write the block whole, or fill the one key into the block that
     * exists*, and a file that has neither ends up with both.
     */
    for (const group of ['spells', 'remotes', 'view', 'world', 'walk'] as const) {
      addGroup(group, { ...DEFAULT_INTERNAL.tuning[group] });
    }
    addKey('spells', 'healRequestMs', DEFAULT_INTERNAL.tuning.spells.healRequestMs);
    addKey('remotes', 'healAskAgainMs', DEFAULT_INTERNAL.tuning.remotes.healAskAgainMs);
    addKey('hunting', 'measuredFightsMin', DEFAULT_INTERNAL.tuning.hunting.measuredFightsMin);
    addKey('view', 'questRunLingerMs', DEFAULT_INTERNAL.tuning.view.questRunLingerMs);
    addKey('world', 'anotherWayPenalty', DEFAULT_INTERNAL.tuning.world.anotherWayPenalty);
    addKey('world', 'anotherWayLonger', DEFAULT_INTERNAL.tuning.world.anotherWayLonger);
    addKey('world', 'hazardSupplyCount', DEFAULT_INTERNAL.tuning.world.hazardSupplyCount);

    /** A key this build no longer reads, taken out rather than left to mean nothing. */
    const dropKey = (group: string, key: string): void => {
      const block = document.getIn(['tuning', group], true);
      if (!isMap(block)) return;
      const index = block.items.findIndex((item) => keyText(item) === key);
      if (index === -1) return;
      block.items.splice(index, 1);
      removed.push(`tuning.${group}.${key}`);
      changed = true;
    };

    dropKey('combat', 'movePendingMs');
    /*
     * The Hunting card's reach, retired with the reach chips (todo 00,
     * 2026-09-13): the survey sweeps everything the exits reach, and distance
     * is a column rather than a bound. Not carried into `huntReaskMs` — steps
     * and milliseconds are not the same quantity.
     */
    dropKey('view', 'huntRadiusSteps');
    /*
     * The suggestion cap moved with the sweep: twelve rows out of a radius
     * were a neighbourhood, twelve out of the realm are a keyhole. A file
     * still stating the old shipped figure takes the new one; a figure the
     * player chose is left alone, because only the shipped value is known to
     * be nobody's decision.
     */
    const raiseKey = (group: string, key: string, from: number, to: number): void => {
      const block = document.getIn(['tuning', group], true);
      if (!isMap(block)) return;
      const pair = block.items.find((item) => keyText(item) === key);
      if (pair === undefined || !isScalar(pair.value) || pair.value.value !== from) return;
      pair.value.value = to;
      added.push(`tuning.${group}.${key} ${from} → ${to}`);
      changed = true;
    };
    raiseKey('hunting', 'maxSpots', 12, DEFAULT_INTERNAL.tuning.hunting.maxSpots);
    /*
     * The search ceiling, retired: a `Hidden/Searchable` exit is one the realm
     * says a search reveals, and giving up after two rolls of a skill check
     * struck a real corridor out of every route for the session (todo 04).
     * The number is deliberately **not** carried into `searchRetryMs` — a
     * count of searches and a delay between them are not the same quantity,
     * and writing 2 into a milliseconds field would be the migration inventing
     * a figure.
     */
    dropKey('walk', 'searchTries');
    const tallyAt = tuning.items.findIndex((item) => keyText(item) === 'tally');
    if (tallyAt !== -1) {
      tuning.items.splice(tallyAt, 1);
      removed.push('tuning.tally');
      changed = true;
    }

    return changed;
  });

  if (added.length === 0 && removed.length === 0) return;
  note(
    t('notices.migration.tuningKeysChanged', {
      file: home.internal,
      added: added.length > 0 ? added.join(', ') : t('notices.migration.tuningNothingAdded'),
      removed: removed.length > 0 ? removed.join(', ') : t('notices.migration.tuningNothingRemoved')
    })
  );
}

function editOptions(home: Home, change: (document: Document) => boolean): void {
  edit(home.options, change);
}

/**
 * The document in `file`, fresh for the caller to change: a clone of this
 * run's parse while the text is unchanged (`parsed`), else a new parse. Null
 * for a file that will not parse, which is left alone.
 */
function documentOf(file: string): Document | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const kept = parsed?.get(file);
  if (kept !== undefined && kept.text === text) return kept.document.clone();
  let document: Document;
  try {
    document = parseDocument(text);
  } catch {
    return null;
  }
  if (document.errors.length > 0) return null;
  parsed?.set(file, { text, document: document.clone() });
  return document;
}

/** The template's document, to read and never to change or take nodes from. */
function templateOf(template: string | undefined): Document | null {
  if (template === undefined || !fs.existsSync(template)) return null;
  const kept = parsed?.get(template);
  if (kept !== undefined) return kept.document;
  let document: Document;
  try {
    document = parseDocument(fs.readFileSync(template, 'utf8'));
  } catch {
    return null;
  }
  if (document.errors.length > 0) return null;
  parsed?.set(template, { text: '', document });
  return document;
}

function edit(file: string, change: (document: Document) => boolean): void {
  if (!fs.existsSync(file)) return;
  const document = documentOf(file);
  if (document === null) return;

  let changed = false;
  try {
    changed = change(document);
  } catch {
    return;
  }
  if (!changed) return;

  try {
    fs.copyFileSync(file, `${file}.bak`);
    const temporary = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, String(document), 'utf8');
    fs.renameSync(temporary, file);
    /*
     * Parsed again by the next step, not kept: a step may set a plain value
     * into a map, which prints the same but is not the node a parse makes.
     */
    parsed?.delete(file);
  } catch {
    // Reported by the store that reads it next; a failed move is not a reason
    // to refuse to start.
  }
}

/**
 * Moves a file or directory, and does nothing at all if it cannot.
 *
 * `rename` fails across filesystems, which a user directory and a source
 * checkout genuinely can be, so a copy-then-remove stands in. Never overwrites.
 */
function move(from: string, to: string): void {
  if (!fs.existsSync(from) || fs.existsSync(to)) return;
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
  } catch {
    try {
      fs.cpSync(from, to, { recursive: true });
      fs.rmSync(from, { recursive: true, force: true });
    } catch {
      // Left where it is, which is the safe direction: the worst case is a
      // file in two places, never a file in none.
    }
  }
}

function listing(dir: string): string[] {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function directories(dir: string): string[] {
  try {
    return directoryNames(dir);
  } catch {
    return [];
  }
}

/**
 * The toolbar gains a back button, and the trail gains the length to feed it
 * (2026-09-13, todo 04).
 *
 * Two edits to `internal.yaml`, for one reason each:
 *
 * - **`move:back` on the row.** A button nobody can find does not exist, and
 *   the shipped row is stated in a file the player already owns a copy of — so
 *   a new button added to the default list reaches nobody who has run the
 *   client before. Appended after `move:toggle` where there is one, and at the
 *   end otherwise, so it lands beside the transport rather than in the middle
 *   of somebody's arrangement. Never added twice, and never to a row the
 *   player has already put it on by hand.
 * - **`tuning.walk.trailSteps` beside `recentSteps`.** The button walks the
 *   trail, and the trail was five steps long because a retreat was all that
 *   read it. A key added inside an existing block reaches nobody who has
 *   already run the client — `statedTheStepNudge`'s reason — and without it
 *   back would work five presses and then stop.
 *
 * The paragraph above `toolbar:` lists every button there is by name, so it is
 * refreshed from the shipped template while it still lacks this one.
 */
function theToolbarGainedBack(
  home: Home,
  note: (message: string) => void,
  template: string | undefined
): void {
  let changed = false;
  edit(home.internal, (document) => {
    let touched = false;

    const walk = document.getIn(['tuning', 'walk'], true);
    if (isMap(walk) && !walk.has('trailSteps')) {
      // The default itself, never a copy: `internal.test.ts` binds the shipped
      // template to `TUNING_DEFAULTS`.
      const pair = document.createPair(
        'trailSteps',
        DEFAULT_INTERNAL.tuning.walk.trailSteps
      ) as Pair;
      const at = walk.items.findIndex(
        (item) => isScalar(item.key) && String(item.key.value) === 'recentSteps'
      );
      if (at === -1) walk.items.push(pair);
      else walk.items.splice(at + 1, 0, pair);
      if (isScalar(pair.key)) pair.key.commentBefore = TRAIL_STEPS_COMMENT;
      touched = true;
    }

    const buttons = document.getIn(['toolbar', 'pinned'], true);
    if (
      isSeq(buttons) &&
      !buttons.items.some((item) => isScalar(item) && item.value === 'move:back')
    ) {
      const at = buttons.items.findIndex((item) => isScalar(item) && item.value === 'move:toggle');
      const pin = document.createNode('move:back') as Scalar;
      pin.commentBefore = BACK_BUTTON_COMMENT;
      if (at === -1) buttons.items.push(pin);
      else buttons.items.splice(at + 1, 0, pin);
      touched = true;
    }

    const toolbar = document.get('toolbar', true);
    const lead = document.contents;
    if (isMap(toolbar) && isMap(lead)) {
      const pair = lead.items.find((item) => keyText(item) === 'toolbar');
      const key = pair === undefined ? null : (pair.key as Scalar);
      const current = key === null ? undefined : key.commentBefore;
      if (typeof current === 'string' && !current.includes('move:back')) {
        const fresh = templateLead(template, 'toolbar');
        if (fresh !== undefined && fresh !== current) {
          key!.commentBefore = fresh;
          touched = true;
        }
      }
    }

    changed ||= touched;
    return touched;
  });
  if (changed) note(t('notices.migration.toolbarGainedBack', { file: home.internal }));
}

const BACK_BUTTON_COMMENT = ` One room back the way you came, per press. A walk into a room nobody meant
 to be in is answered by a press rather than by working out which direction
 undoes it -- and the way back is a route, so a one-way exit or a door that
 shut behind you is answered too (it asks first when the way back is not a
 single step).`;

const TRAIL_STEPS_COMMENT = ` How many confirmed moves the trail keeps -- the back button's history.

 Where we came from, as a list of rooms and the move that joined each pair, so
 going back is a route to the previous room rather than the opposite of the
 last direction: a one-way exit has no opposite, and a text exit ("go manhole")
 is not a direction at all. Each press of back walks one entry and gives it up;
 the forward moves push.`;

/**
 * Three transport buttons become one, and the wander check gains its figure.
 *
 * `loop:toggle`, `loop:stop` and `walk:stop` were the toolbar asking the
 * player to know whether they were looping or routing before they could press
 * the right key. They are one thing — moving — so they are one button,
 * `move:toggle`, and the palette's `loop:stop` is `move:stop` for the same
 * reason.
 *
 * **Both lists are ids in a file the client tells the player to edit by hand**
 * (`toolbar.pinned`, `palette.pinned`), and a pin left under a retired name is
 * a button that silently stops being drawn — the failure
 * `theLoopSettlesAfterAnEscape` records, in the same two lists. So the pins are
 * renamed in place: the **first** of the three old toolbar ids becomes
 * `move:toggle` and the rest are dropped, which keeps the button roughly where
 * the row already had it rather than appending it at the end.
 *
 * The paragraph above `toolbar:` lists every button there is by name, so it is
 * refreshed from the shipped template when it still recommends the old three.
 * And `tuning.walk.resumeAskSteps` is written in beside `maxHolds`, for
 * `statedTheStepNudge`'s reason: a key added inside an existing block reaches
 * nobody who has already run the client, and this one decides whether pressing
 * play walks a character across the realm or asks first.
 */
function theTransportBecameOneButton(
  home: Home,
  note: (message: string) => void,
  template: string | undefined
): void {
  const retired = ['loop:toggle', 'loop:stop', 'walk:stop'];
  let changed = false;
  edit(home.internal, (document) => {
    let touched = false;

    const walk = document.getIn(['tuning', 'walk'], true);
    if (isMap(walk) && !walk.has('resumeAskSteps')) {
      // The default itself, never a copy: `internal.test.ts` binds the shipped
      // template to `TUNING_DEFAULTS`, and a literal here would be a third copy
      // nothing binds. `statedTheStepNudge` states the whole argument.
      const pair = document.createPair(
        'resumeAskSteps',
        DEFAULT_INTERNAL.tuning.walk.resumeAskSteps
      ) as Pair;
      const at = walk.items.findIndex(
        (item) => isScalar(item.key) && String(item.key.value) === 'maxHolds'
      );
      if (at === -1) walk.items.push(pair);
      else walk.items.splice(at + 1, 0, pair);
      if (isScalar(pair.key)) pair.key.commentBefore = RESUME_ASK_COMMENT;
      touched = true;
    }

    const buttons = document.getIn(['toolbar', 'pinned'], true);
    if (isSeq(buttons)) {
      const has = (id: string): boolean =>
        buttons.items.some((item) => isScalar(item) && item.value === id);
      let kept = has('move:toggle');
      const left = buttons.items.filter((item) => {
        if (!isScalar(item) || !retired.includes(String(item.value))) return true;
        touched = true;
        if (kept) return false;
        // The first of the three takes the new name where it already sat.
        item.value = 'move:toggle';
        kept = true;
        return true;
      });
      buttons.items = left;
    }

    const navigate = document.getIn(['palette', 'pinned', 'navigate'], true);
    if (isSeq(navigate)) {
      const already = navigate.items.some((item) => isScalar(item) && item.value === 'move:stop');
      navigate.items = navigate.items.filter((item) => {
        if (!isScalar(item) || item.value !== 'loop:stop') return true;
        touched = true;
        if (already) return false;
        item.value = 'move:stop';
        return true;
      });
    }

    const toolbar = document.get('toolbar', true);
    const lead = document.contents;
    if (isMap(toolbar) && isMap(lead)) {
      const pair = lead.items.find((item) => keyText(item) === 'toolbar');
      const key = pair === undefined ? null : (pair.key as Scalar);
      const current = key === null ? undefined : key.commentBefore;
      if (typeof current === 'string' && retired.some((id) => current.includes(id))) {
        const fresh = templateLead(template, 'toolbar');
        if (fresh !== undefined && fresh !== current) {
          key!.commentBefore = fresh;
          touched = true;
        }
      }
    }

    changed ||= touched;
    return touched;
  });
  if (changed) note(t('notices.migration.oneTransportButton', { file: home.internal }));
}

/**
 * The paragraph the shipped template puts above one **top-level** block.
 *
 * `templateComments` reads one and two levels *inside* a root block, which is
 * where every stale paragraph it was written for lives. This one is the root
 * block's own lead, and the list of button ids is in it.
 */
function templateLead(template: string | undefined, root: string): string | undefined {
  const document = templateOf(template);
  if (document === null) return undefined;
  const contents = document.contents;
  if (!isMap(contents)) return undefined;
  const pair = contents.items.find((item) => keyText(item) === root);
  if (pair === undefined) return undefined;
  const comment = (pair.key as Scalar).commentBefore;
  return typeof comment === 'string' ? comment : undefined;
}

const RESUME_ASK_COMMENT = ` How far the character may have wandered from what it was walking before
 pressing play asks about it first.

 A stop is a pause that may or may not be permanent, so the thing it stopped is
 still there hours later -- and the character may have been walked across the
 realm, or killed and reborn in a temple on another map, in between. Picking it
 back up is then a journey in its own right that nobody asked for, which on a
 realm full of wandering monsters is not free. Past this many steps the client
 answers play with a question.

 Measured as how much *further* away the character is now than when the
 movement stopped -- for a route and for a lap alike, so a movement stopped and
 started again from the same room never asks however far it still has to go,
 and a character killed and reborn two maps away does.`;
