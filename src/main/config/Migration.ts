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
  type YAMLMap
} from 'yaml';

import { fileSlug } from '../../shared/files';
import { t } from '../app/i18n';
import { ACTIONABLE_REMOTES } from '../../shared/remotes';
import { DEFAULT_CONFIG, DEFAULT_REALM_NAME } from '../../shared/config';
import { DEFAULT_INTERNAL } from '../../shared/internal';
import { DENOMINATIONS } from '../../shared/character';
import type { Home } from '../app/home';
import { directoryNames } from './dirs';
import { discoveryKey, type Discovery } from '../../shared/memory';
import { realmKey } from '../world/RealmLore';

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
   * The shipped realms directory, so a realm added to it after somebody's home
   * was created still reaches them.
   *
   * `seedServers` copies this **only when `servers/` does not exist at all**,
   * which is right — a realm somebody deleted must not come back on every
   * launch — and which means a realm added later reaches nobody who has already
   * run the client. That is the invisible-setting failure applied to a
   * directory, and this repository has shipped it once already: the tab rail
   * was complete and tested and did not appear, because the options file it was
   * read from had no profiles directory.
   */
  shippedRealms?: string;
  /** Said out loud: into the console and the terminal. */
  note: (message: string) => void;
}

/**
 * The directory `GMUD (5X)` ships in — the id, which never changes, against the
 * name in the file, which is what a character refers to and what a player reads.
 */
const GMUD_REALM_ID = 'gmud-5x';

/** What the state directories are called, so a legacy root moves whole. */
const STATE = ['memory', 'fights', 'realms', 'logs'];
const STATE_FILES = ['internal.yaml', 'mob-lore.json', 'workspace.json'];

/**
 * Brings whatever is on disk up to the current shape. Safe to call every launch.
 */
export function migrateHome(options: MigrationOptions): void {
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
  theEscapeIsADirection(home, note, options.template);
  theLoopSettlesAfterAnEscape(home, note, options.internalTemplate);
  statedAutoReconnect(home, note);
  statedTheLightAndSupplies(home, note);
  theTuningBlockGainedKeys(home, note, options.internalTemplate);
  theRealmsGainedGmud(home, note, options.shippedRealms);
}

/**
 * `GMUD (5X)` reaches a home that already has a `servers/` directory.
 *
 * The realm is shipped in `resources/servers/gmud-5x/` and is what
 * `DEFAULT_REALM_NAME` and `profile.default.yaml` name, so a new character
 * starts on it — and `seedServers` would never put it on the disk of anybody
 * who has run this client before, because it copies the whole directory or
 * nothing. A default naming a realm the player does not have is the settings
 * screen falling back to whichever realm sorts first, silently.
 *
 * **Matched by name, not by directory.** Somebody who added this realm by hand
 * has it under an id of their own choosing, and a second entry dialling the
 * same address is one nobody can tell apart on the Realms page — and a repeated
 * name is dropped after the first, so the copy would be a row that never wins.
 *
 * The honest limit is `askedTheBankOnEntry`'s, one level up: a *directory* has
 * no way to say "I deleted this on purpose" either, so somebody who removes the
 * realm gets it back on the next launch. The alternative is a record of which
 * migrations have run, which is a second file about the user's files, and this
 * client does not keep one. It is bounded — one realm, once, and it is the one
 * the client currently defaults to.
 */
function theRealmsGainedGmud(
  home: Home,
  note: (message: string) => void,
  shippedRealms: string | undefined
): void {
  if (!shippedRealms) return;
  const source = path.join(shippedRealms, GMUD_REALM_ID, 'server.yaml');
  if (!fs.existsSync(source)) return;
  // A home with no `servers/` at all is `seedServers`' job, and it copies every
  // shipped realm rather than this one. Doing it here too would race it.
  if (!fs.existsSync(home.serversDir)) return;

  for (const id of directories(home.serversDir)) {
    const file = home.server(id).file;
    if (!fs.existsSync(file)) continue;
    try {
      const document = parseDocument(fs.readFileSync(file, 'utf8'));
      /*
       * A file that will not parse **stops this**, rather than being skipped
       * past. It is not evidence that the realm is absent — the realm this is
       * about may be exactly what that file names — and adding a second one
       * beside it is the duplicate name the header refuses. `parseDocument`
       * collects syntax errors rather than throwing, so this is the common
       * case of an unreadable realm file and the `catch` below is the rare one;
       * they have to agree, and for a while they did not.
       */
      if (document.errors.length > 0) return;
      const name = document.getIn(['name']);
      const called = String(typeof name === 'string' && name.length > 0 ? name : id);
      if (called.toLowerCase() === DEFAULT_REALM_NAME.toLowerCase()) return;
    } catch {
      return;
    }
  }

  const target = home.server(GMUD_REALM_ID);
  // Never over a directory that is already there, whatever is in it: this is
  // code writing into files somebody else owns.
  if (fs.existsSync(target.dir)) return;
  try {
    fs.mkdirSync(target.dir, { recursive: true });
    fs.copyFileSync(source, target.file);
  } catch (error) {
    note(
      t('notices.migration.gmudRealmFailed', {
        realm: DEFAULT_REALM_NAME,
        reason: String(error)
      })
    );
    return;
  }
  note(t('notices.migration.gmudRealmAdded', { realm: DEFAULT_REALM_NAME, file: target.file }));
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
  if (template === undefined || !fs.existsSync(template)) return found;
  let document: Document;
  try {
    document = parseDocument(fs.readFileSync(template, 'utf8'));
  } catch {
    return found;
  }
  if (document.errors.length > 0) return found;
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
  ' own .mdb, .accdb, .sqlite or .db.',
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
      add(['automation', 'combat'], 'avoidUndead', false, COMBAT_KIND_COMMENT);
      add(['automation', 'combat'], 'minMobs', 0, '');
      add(['automation', 'combat'], 'maxMonsterExperience', 0, '');
      add(['automation', 'spells'], 'healBelowInCombat', 0, HEAL_IN_COMBAT_COMMENT);
      add(['automation', 'combat'], 'avoidDeathSpell', false, '');
      add(['automation', 'combat'], 'maxTargetHealth', 0, '');
      add(['automation', 'loot'], 'coinKinds', [...DENOMINATIONS], LOOT_COINS_COMMENT);
      add(['automation', 'loot'], 'stopAtGrade', 'never', LOOT_GRADE_COMMENT);
      add(['automation', 'loot'], 'convertWith', '', LOOT_CONVERT_COMMENT);
      add(['automation', 'loot'], 'convertAt', 'never', '');
      add(['automation', 'loot'], 'minPrice', 0, LOOT_VALUE_COMMENT);
      add(['automation', 'loot'], 'maxEncumbrance', 0, LOOT_WEIGHT_COMMENT);
      add(['automation', 'drop'], 'worthless', false, DROP_WORTHLESS_COMMENT);
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

const DROP_DEFAULT = { enabled: false, items: [], whenEncumbered: false };
/** The template's own words, abridged, so the two files read alike. */
const DROP_COMMENT = ` Dropping named junk, unasked -- the other half of MegaMUD's drop list.
 \`items\` is the only authority on what is junk: nothing you did not name is
 ever dropped, and never anything worn, wielded or lit. Matched by prefix,
 as the server reads \`drop\`. \`whenEncumbered\` holds the junk until the
 server itself grades the load as anything but None. Off by default.`;

const BANKING_DEFAULT = { autoDeposit: false, depositThresholdCopper: 50_000, keepCopper: 500 };
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

const COMBAT_KIND_COMMENT = ` Three refusals about a kind of monster rather than a name, from the realm's
 own columns: undead, casts a spell when it dies (146 monsters do, and nothing
 says so until it already has), and more health than you want to open on --
 0 never refuses. All three are silent where the realm says nothing, and none
 of them touches retaliation.`;

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

const REST_TO_COMMENT = ` Keep sitting back down until health reaches this; 0 is the single sit-down at
 the figure above, which is what this client did before the key existed. The
 server keeps you resting long past \`restBelow\` for free, so that figure only
 describes how a rest begins -- and the first thing to break one above it left
 the character standing for the whole recovery. Casting is one of those things
 (measured 2026-09-02), and standing regenerates six times slower. Set this and
 you get rest, heal, rest, heal. A figure below \`restBelow\` is lifted to it.`;

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
 the one list that ships with anything in it. Two names, and they are the two
 that say nothing the party listing does not already say and do nothing to
 this character: @health is the absolute figures behind the percentage the
 listing shows, and @bless-expired is a member telling this character their
 blessing ran out.

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

function edit(file: string, change: (document: Document) => boolean): void {
  if (!fs.existsSync(file)) return;
  let document: Document;
  try {
    document = parseDocument(fs.readFileSync(file, 'utf8'));
  } catch {
    return;
  }
  if (document.errors.length > 0) return;

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
