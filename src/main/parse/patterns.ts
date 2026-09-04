/**
 * The pattern table.
 *
 * Ported from `megamind-client/src/main/routines/classifier.js`, which is the
 * consolidated form of the ~55 block classes in the CoffeeScript
 * `mudengine/src/blocks/`. Named capture groups are kept verbatim, because the
 * downstream state machine reads them by name and both prior clients already
 * agreed on the names.
 *
 * Ordering matters. `RULES` is evaluated top to bottom and the first match
 * wins, so the specific must precede the general: `user-hits` and `mob-hits`
 * overlap on shape, and `room-name` is deliberately last because its pattern is
 * the loosest thing here.
 *
 * Every pattern is anchored and matches *plain* text — ANSI already stripped by
 * the tokenizer. Colour never appears in a test; see `Classifier` for how it is
 * used as a confidence signal instead.
 */
import type { BlockType } from '../../shared/blocks';
import { ROOM_LIGHTS } from '../../shared/character';

export interface Rule {
  type: BlockType;
  pattern: RegExp;
  /**
   * Which side of a combat line the `line` group names, so `Classifier` knows
   * whether to read a name off its front (`The <name> <verb> you`) or its end
   * (`You <verb> <name>`), or both (`<name> <verb> <name>`). Absent means
   * `attacker`, the only mode there used to be.
   */
  resolve?: 'attacker' | 'target' | 'both';
  /**
   * Whether the leading capitalised word may stand in as the attacker when
   * neither the room nor the realm can name one. Only for lines whose grammar
   * says that word *is* a name — a player's blow, which never carries an
   * article — and never for a monster's, where the first word is `The`.
   */
  nameFallback?: boolean;
  /**
   * SGR foreground codes this line is *expected* to carry, if any. Agreement
   * raises confidence; disagreement lowers it. Never a gate.
   */
  expectColour?: number[];
}

/**
 * The in-game status line, and the single most important pattern here.
 *
 * It is the in-game/out-of-game discriminator: nothing else distinguishes "at a
 * menu" from "in the realm" reliably. Mana is optional because a warrior has
 * none at all — a real capture is `[HP=31]:` with no `/MA=` at all — and the
 * class-dependent `KAI` variant exists for monks. `(Resting)` / `(Meditating)`
 * can appear on either side of the colon depending on version.
 *
 * **The status line is configured by the player, not fixed by the realm.**
 * Across 214 captures it takes 47 shapes (docs/capture-analysis.md §1) —
 * `[HP=498/498,MA=391/442]:`, `[HP=580/754,Need=16848293]:`,
 * `[H=100|M=50|E=200]:`, `[HP=100 MA=50 XP=200]` with no colon at all — and
 * the old pattern read 78% of them. So this is a field grammar: `HP` (or `H`)
 * first, `current` or `current/maximum`; then optionally the mana field under
 * any of its four keys, separated by `/`, `,`, `|` or a space; then whatever
 * else was switched on (`Exp=`, `Need=`, `Wealth=`, `: Need n XP`), kept
 * verbatim in `fields` for the tracker to read what it recognises and skip
 * the rest. `HP=n/n` is current *of maximum* — the number this client
 * otherwise waits on a stat sheet for, printed on every line.
 */
/**
 * The prompt, and the one thing that says the character is in the realm.
 *
 * **Health may be negative and the pattern used to refuse it.** A character on
 * its way down prints `[HP=-25/MA=26]:` and `[HP=-115/KAI=5]:` — 126 such
 * prompts across the 218 posted captures and every recorded session, all of
 * them unread, which froze the health readout at the last positive figure for
 * exactly the run of lines a player is watching it hardest. It also cost the
 * one death in the corpus its sentence: `You have been killed!` arrives glued
 * to that prompt (`tailAfterPrompt`), and a prompt that does not match has no
 * tail to peel.
 *
 * Only health takes a sign. Mana never goes negative anywhere in that corpus,
 * and a sign added where nothing has been seen is a guess.
 */
export const STATUS_LINE =
  /^\[(?:HP|H)=(?<hp>-?\d{1,6})(?:\/(?<hpMax>\d{1,6}))?(?:[/,| ]\s*(?<manaType>MA|KAI|M|K)=(?<mana>\d{1,6})(?:\/(?<manaMax>\d{1,6}))?)?(?<fields>[^\]]*?)(?:\s?\((?<stateA>Resting|Meditating)\)\s?)?\]:?(?:\s?\((?<stateB>Resting|Meditating)\))?/;

export const RULES: Rule[] = [
  /* ---------------------------------------------------------- session */
  { type: 'prompt-username', pattern: /^Please enter your username or "new":/ },
  { type: 'prompt-password', pattern: /^Please enter your password:/ },
  /*
   * The account-creation path asks twice more, and the server echoes `*` for
   * every keystroke at both — captured live on orohost 2026-08-26, after `new`
   * at the username prompt. A type of its own rather than `prompt-password`:
   * the capture's redaction arms on both, but the automator must never answer
   * "choose a password" with the configured one, because that creates an
   * account. Both answers sat in that capture verbatim for want of this rule.
   */
  {
    type: 'prompt-new-password',
    pattern: /^Please (?:enter the password you would like to use|confirm your new password):/
  },
  { type: 'prompt-selection', pattern: /^Please enter your selection:/ },
  { type: 'prompt-realm', pattern: /^Please select a realm:/ },
  { type: 'prompt-character', pattern: /^Please select a character:/ },
  { type: 'prompt-menu', pattern: /^\[(?<realm>MAJORMUD|PARADIGM)\]:/ },
  { type: 'login-failed', pattern: /^Invalid username\/password!/ },
  {
    type: 'login-welcome',
    pattern: /^Welcome (?:back, (?<name>\w+)!|to the official (?<realm>\w+) server!)/
  },

  { type: 'user-exits-realm', pattern: /^You will exit after a period of silent meditation\./ },

  /* ----------------------------------------------------------- status */
  { type: 'status-line', pattern: STATUS_LINE },
  {
    type: 'user-experience',
    pattern:
      /^Exp: (?<exp>\d+) Level: (?<level>\d+) Exp needed for next level: (?<needed>\d+) \((?<required>\d+)\) \[(?<percent>\d+)%\]/
  },
  {
    type: 'user-profile',
    pattern: /^(?:Recent Deaths:|Location:\s+(?<map>\d{1,3}),(?<room>\d{1,6}))/
  },
  {
    type: 'user-encumbrance',
    pattern:
      /^Encumbrance:\s+(?<carried>\d+)\/(?<max>\d+)(?:\s+-\s+(?<encumbranceWord>[A-Za-z][A-Za-z ]*?))?(?:\s+\[|\s*$)/
  },
  /*
   * `train` at the guild, captured live (`npm run probe:play`, 2026-08-26):
   *
   *     You hand over 0 copper farthings to train to the next level!
   *     Welcome to level 2!
   *     You gain 0 additional lives.
   *     You gain 10 CPs
   *     You have learned a new power way of the swan!
   *
   * The level is the fact the tracker keeps; the rest are worth an alert and
   * nothing else — a new power is what a caster's rules were waiting for.
   */
  { type: 'user-levels', pattern: /^Welcome to level (?<level>\d+)!/ },
  /*
   * This character's own death, captured live (2026-08-27,
   * `logs/2026-08-27_21-24-03_main.mudcap.jsonl`) and 17 times in the corpus:
   *
   *     [HP=-115/KAI=5]:
   *     You drop to the ground!
   *     You have been killed!
   *     But, due to a miracle, you have been saved.
   *     You have 8 lives left.
   *     [HP=101/KAI=5]:
   *     Temple, Halls of the Dead
   *     Obvious exits: up
   *
   * **`You have been killed!` is the one matched**, and not the three around
   * it. `You drop to the ground!` is the same sentence `player-dies` reads for
   * somebody else and arrives a line early — a character on -115 health may
   * still be saved, and the client acting on the earlier line would tear down
   * a fight that was about to be survived. The miracle line is the *outcome*
   * and says nothing this one does not. And a realm that does not save you
   * prints no miracle at all, so keying on it would miss the deaths that
   * matter most.
   *
   * The room two lines later is the temple, and it is **not** where the last
   * command led. See `Expectations.died`.
   */
  { type: 'user-dies', pattern: /^You have been killed!$/ },
  {
    type: 'user-lives',
    pattern: /^You have (?<lives>\d+) (?:lives|life) left\.$/
  },
  {
    type: 'user-trains',
    pattern: /^You hand over (?<price>\d+) copper farthings to train to the next level!/
  },
  {
    type: 'user-learns',
    pattern: /^You have learned a new (?<kind>power|spell|skill|ability) (?<name>.+?)!$/
  },
  /*
   * A scroll read. Captured on the live realm 2026-09-03, both spellings the
   * one sentence produced:
   *
   *   [HP=40/MA=8]:read harm
   *   You add harm to your spellbook!
   *   [HP=40/MA=8]:read minor
   *   You add minor healing to your spellbook!
   *
   * The name is the realm's own, expanded from whatever prefix was typed, so
   * it is looked up rather than trusted as a spelling — see the tracker's case.
   */
  { type: 'user-reads-spell', pattern: /^You add (?<name>.+?) to your spellbook!$/ },
  { type: 'user-gains', pattern: /^You gain (?<count>\d+) (?<what>additional lives|CPs?)\.?$/ },
  {
    type: 'user-warnings',
    pattern:
      /^You will (?<state>no longer be stopped from performing evil actions|now be warned and stopped from doing most evil actions)\.$/
  },
  /*
   * Blindness is **two sentences**, and the punctuation is the whole of the
   * difference between them.
   *
   * `You are blind!` is the onset: ten in the corpus, every one of them on the
   * line after the thing that caused it — `The saracen zealot casts blind on
   * you!`, `Leo the Quick casts flash, blinding everyone in the room!`,
   * `Shadow Master throws a smoke bomb to the ground!` — and it is what the
   * player's own log of 2026-09-01 shows behind `black orc shaman casts blind
   * on you!`. This is the one worth an alert, because the decision it changes
   * — keep fighting or run — is exactly the one being made while it is true.
   *
   * `You are blind.` is the server declining to draw a room, and is
   * `room-unseen` below. It was read as the onset here on the count alone: the
   * 31 full stops were taken for the announcement and the 10 bangs matched
   * nothing, so the client raised a warning once per *look* for as long as the
   * condition lasted and never once when it began.
   */
  { type: 'user-blinded', pattern: /^You are blind!$/ },
  /*
   * And the same sentence with a full stop, which is a room block wearing a
   * condition's words.
   *
   * Thirty-one in the corpus across three captures, and **28 of them sit
   * directly behind a status line** — it is the answer to a command, never
   * volunteered beside the blow that caused it the way the bang is. (The other
   * three are in `captures/053`, whose poster's client visibly reorders lines
   * and truncates prompts mid-word; §10 of docs/capture-analysis.md is the
   * standing warning about that file's decoration.) `captures/007` has it
   * answering a bare Enter, a `l`, a peek (`l n`) and a move (`n`);
   * `captures/191` has it answering a look at a monster (`l am`).
   *
   * The move is the one that costs something, and that it really is a move is
   * captured twice. In `captures/007` the character opens the door north,
   * sends `n`, gets this line and nothing else, and later closes the same door
   * to the **south** — it went through. In the player's log of 2026-09-01 a
   * `nw` into a pit is answered with `You step onto the crumbling edge of a
   * pit, and fall inside!` and this, and the `rm` sent later reads `1,1765`,
   * one room on from where it started.
   *
   * Typed as an affliction, nothing consumed that move, and `pendingMoves`
   * never came back down: auto-combat suppresses retaliation while a step is
   * unanswered, so the character stood in the dark being hit and hitting
   * nothing back until the player intervened. That is the identical failure
   * the toll refusal above was written for, arriving by a different sentence.
   */
  { type: 'room-unseen', pattern: /^You are blind\.$/ },
  /*
   * The conditions the corpus states both ends of, so a flag can be set and
   * cleared from the wire rather than guessed at (2026-08-29; counts across
   * the 218 posted captures). `You can see again!` ends blindness (2; a third
   * copy carries a leading `[` that is the poster's client, not the server).
   * Poison arrives two ways (2 + 1) and leaves as `The dizzying poison runs
   * its course.` (1). Disease is `You are inflicted with a hideous rotting
   * disease!` (1; another player's `<Name> is inflicted …` is a different
   * fact and not read here) and leaves as `The disease dies down.` (1).
   * Paralysis is `Your legs are paralyzed!` (9) and `You are held by …!` (1,
   * the words after `by` being the monster's own attack text), both ended by
   * `You can move again!` (3). Single samples are marked as such: where the
   * wire disagrees, the wire wins.
   */
  { type: 'user-blind-ends', pattern: /^You can see again!$/ },
  {
    type: 'user-poisoned',
    pattern: /^(?:You are dizzy and disoriented from poison|Poison burns through your veins)!$/
  },
  { type: 'user-poison-ends', pattern: /^The dizzying poison runs its course\.$/ },
  { type: 'user-diseased', pattern: /^You are inflicted with a hideous rotting disease!$/ },
  { type: 'user-disease-ends', pattern: /^The disease dies down\.$/ },
  { type: 'user-held', pattern: /^(?:Your legs are paralyzed|You are held by .+)!$/ },
  { type: 'user-held-ends', pattern: /^You can move again!$/ },
  /* `You are now resting.` — the flag the next status line will carry, said first. */
  { type: 'user-rests', pattern: /^You are now (?<state>resting|meditating)\.$/ },

  /* ----------------------------------------------------------- combat */
  { type: 'combat-status', pattern: /^\*Combat (?<status>Engaged|Off)\*/ },
  { type: 'user-gain-experience', pattern: /^You gain (?<exp>\d+) experience\./ },
  /*
   * A monster's blow — landing, or not — and nothing here says which words it
   * is made of.
   *
   * Both frames are fixed by the template and everything inside them is realm
   * data. `Monsters.AttName-0` for a giant rat is the literal string `bites
   * you`; one realm ships **876 distinct ones** with 368 different leading
   * words, including `darts forward and bites you`, `leaps into the air and
   * kicks you` and `savagely tears you with her fangs`. So the old pair —
   * `The <name> <one word> you for <n> damage!` and `The <name> <one word> at
   * you.` — matched a minority of them and, worse, matched neither of the two
   * lines that were sitting in front of somebody when this was found:
   *
   *     The thin carrion beast snaps at you with its teeth!
   *     The large lashworm lunges at you!
   *
   * Neither is a miss ending in a full stop, and the client therefore did not
   * know it was being attacked at all — it went on trying to open a fight with
   * a monster that was already dead while a second one hit it eleven times.
   *
   * What is fixed is the frame (docs/greatermud/messages.md): a hit ends
   * `for <n> damage!`, and an attack aimed at this character says `you`. The
   * name is **not** captured, because nothing in the grammar says where it
   * ends; `Classifier` fills `attacker` in afterwards from the room and the
   * realm's monster table (`nameInMessage`), and leaves it out when neither can
   * say rather than inventing one.
   *
   * `\byou\b` is what separates a blow aimed at this character from the
   * room's view of one aimed at somebody else (`The %s slashes %s for %s
   * damage!`) — and it will not match `Youssef`. The tail after `you` is
   * bounded to the length an attack message runs to, so an ordinary sentence
   * that happens to mention the reader does not become a combat line, and a
   * quotation mark anywhere disqualifies both: speech is not a swing.
   *
   * The loose end, stated rather than guarded: a *description* sentence
   * beginning `The`, containing `you` and ending in a full stop would match —
   * `The path leads you north.` is the shape. Measured against a live capture
   * it does not happen: 87 room descriptions and 108 lines beginning `The`,
   * none claimed. And the guard that would rule it out — refusing the pattern
   * while inside a room description — is the one that would re-introduce the
   * bug this replaced, by dropping a monster that attacked while the room was
   * still printing. A missed attack costs a character; a lost description line
   * costs a line.
   */
  {
    type: 'mob-hits',
    // `A withering blast of dragonfire sears you for 152 damage!` — a spell's
    // effect line carries an indefinite article and names no caster, so it is
    // a blow nothing can name: counted, and attributed to nobody.
    pattern: /^(?:The|A|An) (?<line>[^"]*?\byou\b[^"]*?) for (?<damage>\d+) damage!/
  },
  { type: 'mob-misses', pattern: /^The (?<line>[^"]*?\byou\b[\w' ]{0,32})[.!]$/ },
  /*
   * The same swing at this character from something with no article — a
   * player (`Rend swings at you!`, 40 lines) or a monster with a proper name
   * (`Champion Gudruk swings at you with a dwarven axe!`). The leading word is
   * a name by grammar, so it stands in when the room has not listed the
   * attacker, exactly as it does for a landed blow.
   */
  {
    type: 'mob-misses',
    pattern:
      /^(?<line>(?<first>[A-Z][\w'-]*)(?: [^"]*?)?) \w+ at you(?: with (?:his|her|its|their|a|an|the) [\w' -]+?)?!$/,
    nameFallback: true
  },
  /*
   * This character's own swing that did not land.
   *
   * `You swing at thin carrion beast!` — the verb is the *weapon's* data, so
   * again only the frame is fixed. It matters for one reason: the target used
   * to be learned only from a blow that landed, so a fight opened with a run of
   * misses had no target at all, and the round verbs — which name what they
   * swing at precisely so `kic` does not fall back to the server's `LastTarget`
   * — had nothing to name.
   */
  /*
   * `You swing at adult she-dragon with your starsteel greatsword!` — the weapon
   * suffix is an item name from the realm's tables, so it is bounded on
   * ` with your ` and never enumerated. And a thrown weapon puts the item
   * *before* the target: `You hurl your chakram at large black dragon!`
   */
  {
    type: 'user-misses',
    pattern: /^You (?:\w+|\w+ your [\w' -]+?) at (?<target>[\w' -]+?)(?: with your [\w' -]+)?!$/
  },
  /* MajorMUD's one-word form of the same fact: `You miss giant crab!` */
  { type: 'user-misses', pattern: /^You miss (?<target>[\w' -]+)!$/ },
  /*
   * And the armour-turned-it frame, which is the same fact from the other side.
   *
   * `Your punch glances off filthbug!` — docs/greatermud/combat.md names the
   * shape (`The <…>, but the swing glances off!`) and the live capture supplies
   * the one aimed at a monster. The verb is the weapon's data again; `glances
   * off` is the frame.
   */
  { type: 'user-misses', pattern: /^Your \w+ glances off (?:the )?(?<target>[\w' -]+)!$/ },
  /*
   * The answer to `look <mob>`, and the only place this server ever says
   * anything about a monster's health.
   *
   * It names nothing: `LookCommand` prints the monster's name, then its
   * description, then this sentence with a bare pronoun. So the sentence alone
   * cannot say *what* is wounded, and `CharacterTracker` binds it to the target
   * of the look it answers.
   *
   * The band is closed to the eight words `ActionFigure.GetWoundLevel` can
   * produce (`src/shared/wounds.ts`), so a ninth reaches the client as an
   * unclassified line somebody can go and look at rather than as a wound level
   * nothing knows what to do with. `They` and the plural verb are the
   * non-binary case that the newest of the three server builds added.
   */
  {
    type: 'mob-wounded',
    pattern:
      /^(?:He|She|It|They) appears? to be (?<band>unwounded|slightly wounded|moderately wounded|heavily wounded|severely wounded|very critically wounded|critically wounded|mortally wounded)\./
  },
  /*
   * The two refusals automation has to hear, both read out of the server rather
   * than captured — see the note on `attack-refused` in `shared/blocks.ts`.
   *
   * `AttackCommand.Execute` gates five attack types and prints one of these
   * before doing anything else: jumpkick, punch and kick want the Mystic class,
   * bash and smash want the trained ability. The gerund is captured because it
   * is the only thing in the sentence that says *which verb* was refused, and
   * that is what auto-combat drops.
   *
   * Backstab is the odd one: it refuses on the *weapon* rather than the class
   * and the sentence has a different shape, so it is matched separately rather
   * than by widening the first pattern until it would match prose.
   */
  {
    type: 'attack-refused',
    pattern: /^You don't know the first thing about (?<skill>\w+ing)!/
  },
  { type: 'attack-refused', pattern: /^You may not (?<skill>backstab) with this weapon!/ },
  {
    type: 'attack-ineffective',
    pattern: /^Your (?<weapon>weapon|fists) (?:has|have) no effect against this (?<target>.+?)!/
  },
  /*
   * Spells, seen in the corpus rather than read out of the server.
   *
   * The *effect* of a spell is per-spell realm data (`Forked lightning streaks
   * out and fries <mob> for 118 damage!`) and is read by the damage frame
   * below like any other blow. What is fixed is the announcement that names
   * caster, spell and recipient, in two frames: `<caster> cast(s) <spell> on
   * <target>` with an optional amount (`for 20 healing`, `healing 16 damage`,
   * `regenerating 5 damage` — three spellings of one fact across three
   * realms), and MajorMUD's `<caster> moves to cast <spell> upon <target>.`
   * `You have already cast a spell this round!` is the refusal the mid-round
   * tick needs to hear. 36, 218 and 1,198 lines respectively
   * (docs/capture-analysis.md §6).
   */
  { type: 'spell-refused', pattern: /^You have already cast a spell this round!/ },
  /*
   * The wrong book was asked for, and the answer names the right one —
   * captured live (`npm run probe:spellbook`, 2026-09-01): a KAI character's
   * `sp` gets the first sentence, a spellbook caster's `pow` the second.
   * `book` is the listing the server says to ask for, which is what lets the
   * asking routine correct itself instead of going quiet.
   */
  {
    type: 'spellbook-refused',
    pattern:
      /^You may not list your (?:spells|powers)\. You are (?:not )?KAI! You must list your (?<book>spells|powers)\.$/
  },
  {
    type: 'spell-cast',
    /*
     * `you` in the target alternation is the receiving half of the same
     * frame — `Eagle casts greater healing on you!`, `Buster casts chant on
     * you!` (captures/060, /074) — and it is what tells this character a
     * party member has just blessed *it*, which is the fact the blessing
     * tracker keys its peer protocol on.
     */
    pattern:
      /^(?<caster>You|[A-Z][\w'-]*) casts? (?<spell>[\w' -]+?) on (?<target>yourself|you|[A-Z][\w'-]*)(?:,? (?:for|healing|regenerating) (?<amount>\d+) (?:healing|damage))?[!.]$/
  },
  {
    /*
     * The self-cast confirmation that has no `on <target>` frame at all:
     * `You cast protection from evil, and Festus is surrounded in a white
     * glow!` (live, 22 times), `You cast ethereal shield, and a shimmering
     * field forms about you.` (corpus). The spell is bounded by `, and`; the
     * flavour after it is per-spell realm message data and is not read. No
     * target group — the cast landed on the caster, which is what a targetless
     * confirmation means — so `CharacterTracker` treats an absent target from
     * `You` as self. Below the `on` frame so a targeted cast matches that
     * first, and the `duration` gate in the tracker keeps an offensive
     * `You cast X, and it explodes!` off the buff list.
     */
    type: 'spell-cast',
    pattern: /^(?<caster>You) cast (?<spell>[\w' -]+?), and .+[.!]$/
  },
  {
    /*
     * The spellcasting roll failed — first-person and targetless, as the wire
     * prints it (`You attempt to cast bless, but fail.`), and with an optional
     * `at <target>` an offensive cast carries (`You attempt to cast unholy
     * force at Covenant, but fail.`). Nothing landed, so a blessing that
     * failed is still due.
     */
    type: 'spell-failed',
    pattern:
      /^You attempt to cast (?<spell>[\w' -]+?)(?: (?:on|at|upon) (?<target>[\w' -]+?))?, but fail\.$/
  },
  {
    type: 'spell-cast',
    /*
     * The `announced` marker separates this *pre-cast announcement* from the
     * confirmation above: a cast that fizzles or is interrupted still printed
     * this line, so the buff tracker must not establish anything from it. In
     * the corpus all 1,198 are third-person (`upon mummy.`), never `upon
     * you`, and a cast landing on this character prints the confirmation
     * frame even on MajorMUD (`Staphloc casts chant on you!`, captures/002).
     */
    pattern:
      /^(?<caster>[A-Z][\w'-]*) (?<announced>moves to cast) (?<spell>[\w' -]+?) upon (?<target>.+?)\.$/
  },
  /*
   * A duration spell ending. Two frames, both corpus-wide (35 and 14 lines):
   * `The effects of <spell> wear off!` — singular, plural, `.` or `!`, with
   * an optional article the spell's own name does not carry (`The effects of
   * the mummy's curse wears off!`) — and the per-spell endings that keep the
   * `wears off` frame: `Your shield of deflection wears off.`, `The song of
   * soothing wears off.`, `Your heroism wears off.`
   *
   * The endings that abandon the frame entirely (`Your skin returns to
   * normal.`, `The silvery aura fades.`) are per-spell realm message data.
   * None of the three realm databases on hand export the Messages table the
   * server reads them from — checked 2026-09-01: `gmud.mdb`, `gmud20230902.mdb`
   * and `data-Paradigm-1.9-TEST.mdb` carry Classes, Info, Items, (Lairs,)
   * Monsters, Races, Rooms, Shops, Spells, TBInfo and nothing else — so they
   * cannot be enumerated, and a pattern per remembered phrasing would be a
   * pattern from memory. A buff whose ending the client cannot read is
   * expired by its configured fallback clock instead (`Blessings`).
   */
  {
    type: 'user-buff-expired',
    pattern: /^The effects of (?:the )?(?<spell>[\w' -]+?) wears? off[.!]$/
  },
  {
    type: 'user-buff-expired',
    pattern: /^(?:Your|The) (?<spell>[\w' -]+?) wears? off[.!]$/
  },
  {
    type: 'attack-warned',
    pattern:
      /^(?:You are overcome with a feeling of guilt and break off your attack\.|To do this action, you must turn off your evil warnings\.)$/
  },
  /* `You take 8 fire damage!` — damage with no attacker, so no blow is recorded. */
  { type: 'user-takes-damage', pattern: /^You take (?<damage>\d+) (?<kind>[\w ]+?) damage!$/ },
  // `You take 1 damage for bashing the door!` — captured live at a locked door.
  { type: 'user-takes-damage', pattern: /^You take (?<damage>\d+) damage for (?<kind>[\w ]+?)!$/ },
  /*
   * Who hit whom, for a blow that landed. Three frames and one anchor.
   *
   * The old rule assumed the verb was one word and that everything between it
   * and `for <n> damage!` was a name. Measured on the corpus, a third of its
   * 6,001 matches produced a target or attacker that was not a thing — and
   * 424 of them were this character's own *spell*, which set `combat.target`
   * to `fire an acid jet at Thrag`, a fragment a rule interpolating `{target}`
   * would have sent into the room (docs/capture-analysis.md §2). So, as with
   * `mob-hits`, nothing between the name and the frame is matched: the frame is
   * `for <n> damage!`, and `Classifier` reads the names off the ends of `line`
   * from the room and the realm's table, refusing to guess where neither can.
   *
   * 1. `You <anything> <target> for <n> damage!` — this character's blow; the
   *    target is whatever the fragment *ends* in.
   * 2. `<Name> <anything> you <anything> for <n> damage!` — somebody's blow on
   *    this character. A player's carries no article, and the surprise attack
   *    that decides a PvP fight carries a two-word verb (`Lynx surprise chops
   *    you for 59 damage!`), which is exactly the line the old rule turned
   *    into this character attacking a phantom. The leading word is a name by
   *    grammar, so it may stand in when the room has not listed the attacker
   *    — a hidden player who just opened on you is precisely the one the
   *    room has not listed.
   * 3. Anything else ending in the frame is a blow between two other parties,
   *    recorded against the target's ledger and touching neither `target` nor
   *    `attackers`.
   */
  {
    type: 'user-hits',
    pattern: /^(?<attacker>You) (?<line>[^"]+?) for (?<damage>\d+) damage!/,
    resolve: 'target',
    // A plain one-verb blow on something nothing has listed still names its
    // target by grammar; a spell or a throw does not. See `targetByGrammar`.
    nameFallback: true
  },
  {
    type: 'user-hits',
    pattern:
      /^(?<line>(?<first>[A-Z][\w'-]*)(?: [^"]*?)?) (?<target>you)\b[^"]*? for (?<damage>\d+) damage!/,
    resolve: 'attacker',
    nameFallback: true
  },
  {
    type: 'user-hits',
    pattern: /^(?<line>[^"]+?) for (?<damage>\d+) damage!$/,
    resolve: 'both',
    nameFallback: true
  },
  {
    /*
     * The per-spell onset. Learned from the cast it follows, never mapped to a
     * spell by its own wording — see the block type. `!`-anchored, so the `st`
     * sheet's `You feel safe from evil! (90s)` timer form (which the
     * `player-status` batch swallows and the tracker reads out of the sheet
     * text) is a different line and not caught here.
     *
     * **Below every damage frame, deliberately.** `You feel a stabbing pain
     * for 96 damage!` (captures/039) is a blow, not an onset, and this pattern
     * is wide enough to take it — so the combat frames above get it first and
     * the lookahead refuses it outright even if the order ever moves. Sitting
     * here costs nothing: an onset carries no damage clause, so nothing
     * captured reaches the frames above by mistake.
     */
    type: 'spell-onset',
    pattern: /^You feel (?!.*\bfor \d+ damage\b)(?<effect>[\w' -]+?)!$/
  },
  /*
   * `<Name> moves to attack you!` — a player opening on this character, a full
   * round before the first damage line. 87 lines in 36 captures and every one
   * a player name. With somebody else as the target it says what everybody
   * else is fighting; `everyone in the room` is the area attacker.
   */
  {
    type: 'player-attacks',
    pattern: /^(?<attacker>[A-Z][\w'-]*) moves to attack (?<target>.+?)[.!]$/
  },
  /*
   * A swing between two other parties that did not land. The verb is the
   * weapon's, the weapon suffix is an item name, and both are realm data; the
   * frame is `<who> <verb> at <whom>[ with <its> <weapon>]!`. `You ... at` is
   * claimed by `user-misses` above and `The ... you` by `mob-misses`, so what
   * is left is a player at a monster or a monster at a player — the sixth of
   * the corpus that was unread (docs/capture-analysis.md §4).
   */
  {
    type: 'player-misses',
    pattern:
      /^\s*(?<attacker>(?!You\b)(?:The )?[\w'-]+(?: [\w'-]+)*?) (?<verb>\w+) at (?<target>(?!you\b)[\w' -]+?)(?: with (?:his|her|its|their) (?<weapon>[\w' -]+?))?!$/
  },
  {
    type: 'player-misses',
    pattern:
      /^\s*(?<attacker>[\w'-]+)'s (?<verb>\w+) at (?<target>[\w' -]+?) hits, but glances off (?:its|his|her|their) armou?r\.$/
  },
  /*
   * A player's death is composed in `Player.cs` — `<Name> drops to the
   * ground!`, then `<Name> is dead.` — unlike a monster's, which is realm data
   * and deliberately unmatched. 105 lines, 91 distinct names, all players.
   */
  { type: 'player-dies', pattern: /^(?<player>[A-Z][\w'-]*) (?:drops to the ground!|is dead\.)$/ },
  /*
   * Somebody else sitting down, and which of the two it is.
   *
   * The party roster prints a flag for this and a listing costs a command, so
   * the sentence is the free half of the standing shape: `party` establishes
   * who is resting and this keeps it true until the next one. Only the two
   * sit-down verbs are composed by the server; **nothing announces standing
   * up**, in 214 captures or on the wire, so a rest ends silently and only a
   * fresh listing clears it.
   */
  {
    type: 'player-rests',
    pattern: /^(?<player>[A-Z][\w'-]*) (?<verb>stops to rest|kneels to meditate)\.$/
  },

  /* ----------------------------------------------------- conversation */
  /*
   * Read out of `CommManager.cs` rather than seen on the wire; both shapes are
   * ones a live check would only produce with a second player doing something
   * specific, and both were invisible to this client until the server's own
   * source said they existed. See docs/greatermud/communication.md.
   *
   * A *directed* say, which must precede the general one below or the general
   * one swallows it and reports the message as `(to you) "..."`.
   */
  {
    type: 'conversation-directed',
    pattern: /^(?<player>\w+) says \(to (?<target>\w+)\) "(?<message>.+)"/
  },
  /* A yell carries from an adjacent room, and names the direction, not a player. */
  {
    type: 'conversation-yell',
    pattern: /^Someone yells from the (?<direction>[\w ]+) "(?<message>.+)"/
  },
  /*
   * The server tells you when it has stopped listening to chat — unlike the
   * command window, which discards in silence. Worth its own type: it is the
   * one place automation can learn it is being ignored.
   */
  { type: 'comms-throttled', pattern: /^Too many messages sent - please wait/ },
  { type: 'conversation-gossip', pattern: /^(?<player>\w+) gossips: (?<message>.+)/ },
  { type: 'conversation-broadcast', pattern: /^Broadcast from (?<player>\w+) "(?<message>.+)"/ },
  /*
   * `(ghosting - <gang>) ` prefixes a gangpath an admin is observing. An anchor
   * at the start of the line misses every one of them.
   */
  {
    type: 'conversation-gangpath',
    pattern: /^(?:\(ghosting - [^)]*\) )?(?<player>\w+) gangpaths: (?<message>.+)/
  },
  /*
   * Auction. Added after a live check: `Soul auctions: ...` fell through as
   * `unknown`, so the one channel a trader watches all day was invisible to a
   * client that could already see gossip.
   */
  { type: 'conversation-auction', pattern: /^(?<player>\w+) auctions: (?<message>.+)/ },
  { type: 'conversation-telepath', pattern: /^(?<player>\w+) telepaths: (?<message>.+)/ },
  /*
   * The receipts for a message this character addressed to one person, which
   * are the only thing on the wire that says either went out — neither `/Soul
   * hi` nor `>Soul hi` is echoed back as a sentence the way a yell is.
   *
   * `Sent` and `Directed` are capitalised. The telepath receipt was written
   * here from the shape rather than from the bytes and spelled `sent`, so it
   * matched nothing for as long as it has existed: every telepath sent from
   * this client was invisible to it. Captured 2026-08-27, and
   * `CommManager.cs` agrees (docs/greatermud/communication.md).
   */
  { type: 'conversation-telepath', pattern: /^--- Telepath Sent to (?<player>\w+) ---/ },
  { type: 'conversation-directed', pattern: /^--- Message Directed to (?<player>\w+) ---/ },
  { type: 'conversation-yell', pattern: /^(?<player>\w+) yells "(?<message>.+)"/ },
  { type: 'conversation-yell', pattern: /^You yell "(?<message>.+)"/ },
  /*
   * A command the server did not recognise, which it therefore *said out loud*.
   *
   * Captured from the live server: `exits`, `time`, `skills`, `stats` and
   * `gold` all came back as `You say "..."`. This is not a curiosity — it means
   * an unrecognised command is broadcast to everyone in the room, so a typo in
   * a rule file does not fail quietly, it speaks. The client should be able to
   * say so.
   *
   * Ahead of `conversation-local` and guarded in `Classifier`: it only claims
   * the line when the message is exactly the command just sent. Someone typing
   * `say exits` is having a conversation, and falls through to the rule below.
   */
  { type: 'command-not-understood', pattern: /^You say "(?<message>.+)"/ },
  /*
   * This character's own say, with **no `player` group** — the shape `You
   * yell` above already has, for the reason this one needed it.
   *
   * `You` is a pronoun the server writes where a name would go, and the
   * generic rule below captured it as one. Everything downstream believed it:
   * `trackPlayers` filed a player called `You` in the registry (it is not this
   * character's name, so the self check let it through), the Talk card drew it
   * as a control because the registry knew it, and clicking it opened a Player
   * flyout headed `You  OFFLINE`. Reported 2026-09-02 with the screenshot.
   *
   * Absence is how this client already says *this character said it*: the card
   * draws its own word for it and the registry files nobody. A player really
   * called `You` loses their line to this, which is the trade `You yell` made
   * first and the same trade `command-not-understood` makes one line above.
   */
  { type: 'conversation-local', pattern: /^You says? "(?<message>.+)"/ },
  { type: 'conversation-local', pattern: /^(?<player>\w+) says? "(?<message>.+)"/ },

  /* --------------------------------------------------------- presence */
  /*
   * Somebody walking into, or out of, *this room*.
   *
   * A different fact from entering the realm, and the more urgent one: the
   * realm is large and this room is where a fight happens. Captured verbatim
   * from `npm run probe:party` — two characters, one walking to the other.
   */
  {
    type: 'player-arrives-room',
    pattern: /^(?<player>\w+) walks into the room from the (?<direction>[\w ]+)\.$/
  },
  {
    type: 'player-leaves-room',
    pattern: /^(?<player>\w+) just left to the (?<direction>[\w ]+)\.$/
  },
  {
    type: 'player-looks',
    pattern: /^(?<player>[A-Z][\w'-]*) is looking (?<at>around the room|at you)\.$/
  },
  /*
   * A *monster* walking in, which is a different sentence and a different fact.
   *
   * `A large lashworm crawls into the room from the above!` — and the arrival
   * verb is per-monster realm data exactly like the attack message
   * (docs/greatermud/messages.md records the template as
   * `A %s slithers in from %s.`), so once again only the frame is matched and
   * `Classifier` names the monster afterwards.
   *
   * Without it the room's occupant list only ever shrank. A monster that walked
   * in after the last `Also here:` was invisible to everything that reads the
   * room — which is how a client came to spend four commands attacking a
   * monster it had already killed while a second one it had never heard of hit
   * it thirty times.
   *
   * Both endings are accepted because the realm supplies the whole sentence and
   * a full stop is as likely as an exclamation mark — and so are both
   * prepositions: one realm writes `crawls into the room from the above!` and
   * `creeps in the room from the above!` for two monsters in the same room,
   * which is one more reminder that everything but the frame is data. The
   * article is optional for the same reason: `angry carrion beast moves into
   * the room from the east.` arrived without one (live, 2026-08-27), and the
   * article is part of the sentence the realm's operator typed, not the frame.
   */
  {
    type: 'mob-arrives-room',
    pattern:
      /^(?:(?:A|An|The) )?(?<line>.+?) (?:in(?:to)? the room from|in from) (?:the )?(?<direction>[\w ]+)[.!]$/
  },

  /*
   * A travel party, announced rather than asked for. All captured live.
   *
   * The realm calls it *following* rather than joining, which is why the shapes
   * read the way they do: `invite` offers, `join` accepts, and what the server
   * reports is who is following whom.
   */
  { type: 'party-invited', pattern: /^You have invited (?<player>\w+) to follow you\.$/ },

  /*
   * `wealth` — the purse by denomination, in one line.
   *
   * Captured live 2026-08-28: `You have 22 platinum pieces, 50 gold crowns,
   * 3 silver nobles, 4 copper farthings.` against a `Wealth: 225034` from the
   * same session, which is exactly 220 000 + 5 000 + 30 + 4 on the measured
   * ladder. One line for what the `i` listing spends five on, and it was the
   * only thing `npm run probe:tour` found unread that was worth reading.
   *
   * **The noun after the number is not in the pattern**, because it is realm
   * data — `captures/024` has a realm that renamed the runic coin to a `dime
   * bag`. Every part is `<number> <lower-case words>` and the *tracker* decides
   * which denomination each one is, matching the first word exactly as the `i`
   * listing does; a part that names none makes the whole line nothing, so a
   * sentence of the same shape about something else cannot become a purse.
   *
   * Below the other `You have …` rules, which are all more specific, and the
   * digit is what keeps it from reaching them: none of `no keys`, `removed`,
   * `invited`, `moved to the`, `already cast` or `progressed too far` begins
   * with a number.
   */
  {
    type: 'user-wealth',
    pattern: /^You have (?<coins>\d+ [a-z][a-z ]*?(?:, \d+ [a-z][a-z ]*?)*)\.$/
  },
  // The same invitation from the other side, captured live: the leader is
  // named and the pronoun is realm data, so only the frame is matched.
  //
  // It is `leader`, not `player`, because the two sentences are opposite facts
  // wearing one block type — this character invited somebody, or somebody
  // invited this character — and the name of the capture is the only thing that
  // says which. Sharing one name is how another player's loot once landed in
  // this character's pack (`player-gets`); here it would have put the inviter
  // into the party of whoever they invited.
  {
    type: 'party-invited',
    pattern: /^(?<leader>\w+) has invited you to follow (?:him|her|them|it)\.$/
  },
  /*
   * Printed above the roster, and only when this character is not the leader —
   * and again, with `already` in it, when `follow` names somebody this
   * character is following.
   *
   * The second spelling is the same fact and was unread until 2026-08-30: it
   * is in the corpus once (`You are already following Swampfox.`) and arrived
   * on the wire in the overnight run's first minute, where the client
   * concluded it was following nobody and re-formed the party every two
   * minutes all evening. A refusal that restates the state is still a
   * statement of the state.
   */
  { type: 'party-following', pattern: /^You are (?:already )?following (?<leader>\w+)\.$/ },
  {
    type: 'party-joined',
    pattern: /^(?:(?<player>\w+) started to follow you|You are now following (?<leader>\w+))\.$/
  },
  {
    type: 'party-left',
    pattern:
      /^(?:(?<player>\w+) is no longer following you|You are no longer following (?<leader>\w+))\.$/
  },
  /*
   * `uninvite <name>`, captured live (2026-08-28). The offer is withdrawn before
   * it was ever accepted, so the server answers about the *followers* rather
   * than about the party. Unread, an invitation the player had already cancelled
   * stayed on the card until the next `party`.
   */
  {
    type: 'party-left',
    pattern: /^(?<player>\w+) has been removed from your followers\.$/
  },
  {
    type: 'party-rank-changed',
    pattern: /^(?<player>\w+) just moved to the (?<rank>front|middle|back) rank in your group\.$/
  },

  /*
   * Somebody joining or leaving **this character's gang**, broadcast to every
   * member. Captured live (2026-08-29) and confirmed in `JoinCommand.cs:95`
   * and `LeaveCommand.cs:45`, which send them to the gang as a whole.
   *
   * This is the maintained-listing shape, and here it has teeth beyond a card
   * being current: gang membership is a **permission**. `automation.remotes`
   * grants `@` commands to whoever shares this character's gang, so somebody
   * who has just left must stop being answered at once, and somebody who has
   * just joined starts being answered. Without these the client kept answering
   * a former member until the next `who` happened to land — a permission that
   * outlives the thing it was granted for.
   *
   * The leaving line names the gang; the joining line does not, because it is
   * sent only to that gang's own members and there is only one it can mean.
   */
  { type: 'gang-joined', pattern: /^(?<player>\w+) just joined your gang\.$/ },
  /* `gb` from a character in no gang. Read so the one line a gangless
     character gets on entering the realm is typed rather than unclassified. */
  { type: 'gang-none', pattern: /^You are not in a gang at the present!$/ },
  { type: 'gang-left', pattern: /^(?<player>\w+) has left (?<gang>.+)\.$/ },
  // The same fact about this character, captured live: `backrank` answers
  // `You have moved to the back ranks of your group.` and names nobody.
  //
  // The middle rank is the roster's `Midrank` said as a sentence — `mid`
  // answers `You have moved to the middle ranks of your group.` (live,
  // 2026-08-27), and it went unmatched, so this character's own row stayed
  // wherever the last listing put it until the next `party`. The third-person
  // spelling above is the same word in the same frame; the corpus has only
  // ever shown front and back said about somebody else.
  {
    type: 'party-rank-changed',
    pattern: /^You have moved to the (?<rank>front|middle|back) ranks? of your group\.$/
  },

  {
    /*
     * The first line of `look <player>`: the name in brackets and the gang in
     * parentheses when there is one.
     *
     *     [ Nester TheDupe ] (Old Guard)
     *     [ Sirkilla Dathrilla ]
     *
     * Thirteen corpus files across fifteen gangs print the first shape and
     * two print the second, so an absent gang is the server saying there is
     * none rather than a fold. The only per-player statement of gang
     * membership on the wire besides the `who` row's `of <gang>`, and the two
     * agree where both appear (captures/076 prints Nester both ways).
     *
     * **The space before the parenthesis is optional, and the wire is why.**
     * All 25 corpus occurrences are MajorMUD and print `] (Gang)`; GreaterMUD
     * live prints `](Valor)` with none (2026-08-29). Requiring the space
     * matched neither the name nor the gang on this realm — and because the
     * `[ Name ]` line is what the equipment block below is filed against,
     * every `look <player>` here recorded nothing at all: the Worn tab said
     * "nobody has looked" about a player who had just been looked at.
     */
    type: 'player-look',
    pattern: /^\[ (?<name>[A-Z][\w'-]*)(?: (?<last>[^\]]+?))? \](?: ?\((?<gang>.+)\))?\s*$/
  },
  { type: 'player-enters', pattern: /^(?<player>\w+) just entered the Realm\./ },
  { type: 'player-exits', pattern: /^(?<player>\w+) just left the Realm\./ },
  { type: 'player-disconnects', pattern: /^(?<player>\w+) just disconnected!!!/ },

  /* --------------------------------------------------------- movement */
  { type: 'direction-failed', pattern: /^There is no exit in that direction!/ },
  /*
   * The barrier is captured because the two `direction-failed` shapes are not
   * the same fact. `There is no exit in that direction!` means the realm data
   * was wrong and no retry helps; a closed door is closed until something opens
   * it, and `open` is the thing that opens it. `Walker` reads the difference —
   * see `automation.movement.openDoors`.
   */
  {
    type: 'direction-failed',
    pattern: /^The (?<barrier>door|gate) is closed(?: in that direction)?!/
  },
  /*
   * `You may not go through this exit!` — a gate on alignment or level, not a
   * wall and not a door. It consumes the pending move like the other two, and
   * carries no barrier because nothing the client can send opens it.
   */
  { type: 'direction-failed', pattern: /^You may not go through this exit!/ },
  /*
   * `You have progressed too far to go through this exit!` — the same gate seen
   * from the other side: the character has outgrown the level band the exit
   * allows. Captured live 2026-08-27 with Vaelor at level 6 standing *inside*
   * `Docks is gated (Level: 0 to 5)`, where every way out answers this.
   *
   * It matters far more than a missing message. `direction-failed` is what
   * consumes the pending move, and without it a refusal leaves a phantom
   * direction in the queue — so the next room the character genuinely does
   * reach is resolved against an exit it never took. The sibling sentence
   * above has been read since phase 3; this one walked straight into the
   * failure the tracker already documents.
   */
  {
    type: 'direction-failed',
    pattern: /^You have progressed too far to go through this exit!/
  },
  /*
   * `You do not have enough to cover the toll of 5 gold crowns.`
   *
   * **Wire, not memory**: read out of the player's own session log
   * (`2026-08-30_16-01-09_main.log`), where the sequence is exactly the failure
   * this rule exists to stop —
   *
   *     Wealth: 0 copper farthings
   *     [HP=334/KAI=27]:e
   *     You do not have enough to cover the toll of 5 gold crowns.
   *     [HP=334/KAI=27]:The large wild dog snaps at you, ...   (x3, unanswered)
   *
   * A toll refusal consumes the move like every other `direction-failed`, and
   * that is the whole point: `pendingMoves` only falls when a room or a refusal
   * answers the step, `AutoCombat.noteMovePending` suppresses retaliation while
   * one is outstanding, and nothing ever times it out. So an unread refusal
   * does not merely lose a fact — it stops the character hitting back **for the
   * rest of the session**, which is what the three unanswered dog attacks above
   * are. The character stood there because a line went unread.
   *
   * The price is captured because it is the only place the realm states one in
   * coin the client can compare: `Toll: 5` in the realm data turned out to mean
   * *5 gold*, which this sentence is the evidence for (`gold crowns`, against a
   * purse the same listing gave as `0 copper farthings`).
   *
   * No barrier: nothing the client can send opens a toll gate except money.
   */
  {
    type: 'direction-failed',
    pattern: /^You do not have enough to cover the toll of (?<toll>[^.]+)\./
  },
  /*
   * Three more refusals that consume a move, from **the server's own source**
   * (`docs/greatermud/movement.md`) rather than from the wire — no capture in
   * the corpus of 220 holds any of them, and none appears in the player's logs.
   * They are here rather than left out because the cost of the two errors is
   * not symmetric: a pattern for a sentence this realm never sends matches
   * nothing and costs nothing, while a refusal left unread strands a pending
   * move and disables retaliation for the session, which is the defect above.
   * If the wire ever disagrees with these three, the wire wins and they change.
   */
  {
    type: 'direction-failed',
    pattern: /^Your current alignment prevents you from entering this exit\./
  },
  { type: 'direction-failed', pattern: /^You may not enter that room while in combat\./ },
  /*
   * The same family and **not** a `direction-failed`: this one refuses whatever
   * was sent — a move, an attack, a look — and names the condition instead of
   * the command. It is `command-refused` so the tracker consumes the claim
   * without also writing the exit off as one the realm refuses; a step this
   * answers failed because the character is at zero, not because the corridor
   * is shut, and blacklisting the edge would cost every route through it.
   *
   * Verbatim from the wire, 33,402 times across the recorded sessions.
   */
  { type: 'command-refused', pattern: /^You may not do that while you are mortally wounded!/ },
  { type: 'direction-failed', pattern: /^You are too heavy to move!/ },
  { type: 'bash-failed', pattern: /^Your attempts to bash through fail!/ },
  { type: 'heard-movement', pattern: /^You hear movement to the (?<direction>\w+)\./ },
  {
    type: 'door-changed',
    pattern:
      /^(?:The door (?:is|was) (?:now |already )?(?<state>open|closed)\.|You successfully (?<state2>unlocked) the door\.)$/
  },
  /*
   * `You bashed the door open.` — the other way a barrier ends up open, and
   * the half `door-changed` was missing. Captured twice (`captures/005`,
   * `024`), and in 005 the room reprinted straight after with `open door
   * north` while the character stood where it had been: **a bash opens the
   * door and does not move anybody**, so the direction still has to be sent.
   *
   * The noun is substituted — docs/greatermud/movement.md lists `door`, `gate`
   * and `portcullis` for the same frame — so the barrier is captured rather
   * than the word `door` being anchored on.
   */
  {
    type: 'door-changed',
    pattern: /^You bashed the (?<barrier>[\w ]+?) (?<state>open)\.$/
  },
  /*
   * `Your skill fails you this time.` — three attempts of it in `captures/002`
   * before `pi w` answered `You successfully unlocked the door.`
   *
   * The server spends this sentence on more than picking: it is also what a
   * failed `disarm` says (docs/greatermud/movement.md, *Searching, traps and
   * discovery*), and the words name neither skill. So the block type says only
   * what the wire says — a skill was tried and did not work — and the reader
   * supplies the context. `Walker` reads it only while it has a lock-pick in
   * flight for the step it is on.
   */
  { type: 'skill-failed', pattern: /^Your skill fails you this time\.$/ },
  /*
   * `trac <name>`: `Rend went west from here.` or the skill failing. The only
   * answer the game gives to *which way did somebody go*, and against the
   * world graph's exits it is a pursuit route.
   */
  {
    type: 'user-tracks',
    pattern:
      /^(?<player>[A-Z][\w'-]*) went (?<direction>north|south|east|west|northeast|northwest|southeast|southwest|up|down) from here\.$/
  },
  { type: 'user-tracks-failed', pattern: /^Your tracking skills fail you this time\.$/ },
  {
    type: 'party-follows',
    pattern: /^\s*-- Following your Party leader (?<direction>[\w ]+?) --\s*$/
  },

  /* ---------------------------------------------------------- failure */
  { type: 'command-no-effect', pattern: /^Your command had no effect\./ },
  /*
   * The refusal that names its target, in all three spellings the server ships.
   *
   * `You don't see <x> here.` was written from a live capture; the source has
   * two more — `You do not see <x> here!` from `LookCommand`, and `You don't
   * see <x> here!` with the exclamation from several others. A `look` that is
   * refused answers with **no wound sentence**, so a pattern that reads only
   * one spelling leaves the other two unmatched and the queued look unanswered
   * — and the next wound line to arrive binds to it, which puts one monster's
   * condition on another's bar. That is the reassuring-direction failure the
   * look queue exists to prevent, arriving through the back door.
   */
  {
    type: 'target-missing',
    pattern: /^You (?:don't|do not) see (?<target>.+?) here[.!]$/
  },
  /*
   * The other refusal a look can get, and it names nothing: the server lists
   * the candidates on the lines after it. Read for one reason — it means no
   * wound sentence is coming, so the look it answers has to leave the queue.
   */
  { type: 'target-ambiguous', pattern: /^Please be more specific\./ },
  { type: 'open-failed', pattern: /^That is not a door or a gate!/ },
  // `open` at a locked door, captured live in the arena (`npm run probe:play`).
  { type: 'open-failed', pattern: /^The (?<barrier>door|gate) is (?<reason>locked)\.$/ },
  { type: 'user-list-failed', pattern: /^You cannot LIST if you are not in a shop!/ },
  { type: 'command-ignored', pattern: /^You are typing too quickly - command ignored/ },
  { type: 'slow-down', pattern: /^Why don't you slow down for a few seconds\?/ },
  { type: 'user-search-failed', pattern: /^You notice nothing different to the (?<direction>\w+)/ },
  // MajorMUD's phrasing of the same answer, 59 lines in 11 captures.
  { type: 'user-search-failed', pattern: /^Your search revealed nothing\.$/ },
  { type: 'user-search-succeeded', pattern: /^You found an exit to the (?<direction>\w+)!/ },

  /* ---------------------------------------------------------- stealth */
  {
    type: 'user-sneak-failed',
    pattern: /^Attempting to sneak\.\.\.You don't think you're sneaking\./
  },
  { type: 'user-sneak-initiate', pattern: /^Attempting to sneak\.\.\.$/ },
  { type: 'user-sneaking', pattern: /^Sneaking\.\.\./ },
  { type: 'user-not-sneaking', pattern: /^You make a sound as you enter the room!/ },
  { type: 'user-cant-sneak', pattern: /^You may not sneak right now!/ },
  /*
   * Hiding — the same mechanic standing still, and the same three-way split:
   * the attempt is not the outcome, and the corpus never shows the success
   * line, so none is invented here. Glued to the attempt on the failure line
   * exactly as the sneak failure is.
   */
  {
    type: 'user-hide-failed',
    pattern: /^Attempting to hide\.\.\. ?You don't think you are hidden\./
  },
  { type: 'user-hide-initiate', pattern: /^Attempting to hide\.\.\.$/ },
  {
    type: 'user-cant-hide',
    pattern: /^You may not hide (?:while attacking or being attacked|right now)!/
  },

  /* ------------------------------------------------------------ items */
  /*
   * The server counts. `drop 2 gloves` answers `You dropped 2 padded gloves.`
   * (captured live, 2026-08-26), and without the count the item would have
   * been read as one called "2 padded gloves". Optional, because the ordinary
   * single case carries none — and a count of one is never printed.
   *
   * Hiding is a drop the room does not show: `You hid padded gloves.` takes
   * the item out of the pack and puts it nowhere `You notice` will list it.
   */
  { type: 'user-hides', pattern: /^You hid (?:(?<count>\d+) )?(?<item>.+)\./ },
  /* `18 gold drop to the ground.` — the kill's coins landing on the floor. */
  {
    type: 'room-coins',
    pattern: /^(?<count>\d+) (?<coin>copper|silver|gold|platinum|runic) drops? to the ground\.$/
  },
  {
    type: 'user-gets-coins',
    pattern:
      /^You picked up (?<count>\d+) (?<coin>copper farthings?|silver nobles?|gold crowns?|platinum pieces?|runic coins?)\.?$/
  },
  { type: 'player-gets', pattern: /^(?<player>\w+) picks up (?<item>.+)\./ },
  { type: 'player-gets', pattern: /^You took (?:(?<count>\d+) )?(?<item>.+)\./ },
  { type: 'player-drops', pattern: /^(?<player>\w+) drops (?<item>.+)\./ },
  { type: 'player-drops', pattern: /^You dropped (?:(?<count>\d+) )?(?<item>.+)\./ },
  { type: 'user-equipped', pattern: /^You are now wearing (?<item>[\w ]+)\.$/ },
  /*
   * Wielding, captured beside the wearing line it mirrors:
   *
   *     [HP=34]:ar qua
   *     You are now holding quarterstaff.
   *
   * Deliberately the same block type as wearing. The two sentences differ in
   * which slot the item lands in and in nothing else the client acts on, and
   * the slot is not in either sentence — it is in the `i` listing. A second
   * type would be a second thing for every consumer to handle for no fact it
   * could then state.
   */
  { type: 'user-equipped', pattern: /^You are now holding (?<item>[\w ]+)\.$/ },
  { type: 'user-equipped', pattern: /^You lit the (?<item>[\w ]+)\.$/ },
  { type: 'user-equipped-failed', pattern: /^You may not wear that item!/ },
  // `wear` for something already on, captured live while recovering a kit.
  { type: 'user-equipped-failed', pattern: /^You are already wearing (?<item>.+?)!$/ },
  // `arm` for something already in hand, captured live: nothing spare to ready.
  {
    type: 'user-equipped-failed',
    pattern: /^You do not have (?<item>.+?) left unequipped\.$/
  },
  {
    type: 'user-removed',
    pattern: /^You have removed (?<item>[\w ]+?)(?: and extinguished it)?\.$/
  },
  /*
   * A readied light burning down, in the two spellings on record: `Your torch
   * flickers and goes out.` (live, 2026-09-03, festus) and `Your lamp runs out
   * of oil, and goes out.` (the corpus). The torch stays readied and in the
   * pack — the listing would print `(Readied/0)` — so this is the charge
   * reaching zero and nothing else; `AutoLight` removes it before lighting the
   * next one, because the server refuses to light over an occupied slot.
   */
  {
    type: 'light-out',
    pattern: /^Your (?<item>[\w ]+?) (?:flickers and goes out|runs out of oil, and goes out)\.$/
  },
  {
    type: 'user-buys',
    // `for nothing` is the free purchase's own spelling, captured live beside
    // `for 0 copper farthings` (2026-09-01, a scroll of minor healing): both
    // are on the wire and the second was read while the first was not.
    pattern:
      /^You just bought (?:(?<quantity>\d+) )?(?<item>[\w ]+) for (?:(?<price>\d+) copper farthings|nothing)\.$/
  },
  /*
   * Selling, captured beside the buying line it mirrors:
   *
   *     [HP=34]:sell qua
   *     You sold quarterstaff for 0 copper farthings.
   *
   * The price is captured and may be zero — this realm's starter shop sells and
   * buys back for nothing — so a consumer must not read a missing price and a
   * zero price as the same thing.
   */
  {
    type: 'user-sells',
    pattern: /^You sold (?:(?<count>\d+) )?(?<item>[\w '-]+) for (?<price>\d+) copper farthings\.$/
  },
  { type: 'user-list', pattern: /^The following items are for sale here:$/ },
  /*
   * Banking, captured live at the Bank of Godfrey (2026-08-29):
   *
   *     [HP=334/KAI=27]:deposit 102351
   *     You deposit 102351 copper farthings.
   *
   * The sentence names no bank, and it never will. Which account it credited
   * is **not** taken from the room: the room resolves to a bank shop only when
   * the realm file is loaded, the room has been matched, and the data records
   * a shop for it — three conditions that fail routinely, and crediting on
   * that chain attributes a deposit to the wrong vault rather than to none.
   * It is taken instead from the `bank` that answered *in this room*, which
   * named one outright (`bank-balance`), and which `CharacterTracker` holds
   * until the room changes. Where no `bank` has been asked there is no vault,
   * and the purse moves alone.
   *
   * **The withdrawal is the same round trip and the sentence is not
   * symmetric.** `npm run probe:bank` asked (2026-08-29,
   * `logs/2026-08-29_21-18-33_main.mudcap.jsonl`) and the server says `You
   * withdrew 310335 copper farthings.` — past tense, where the deposit's is
   * present. Writing `You withdraw N` from the symmetry, which is what memory
   * would have produced, would have matched nothing forever; the buy/sell
   * pair above is the same lesson in the same file.
   *
   * It also arrives **glued to the prompt** —
   *
   *     [HP=334/KAI=27]:You withdrew 20000 copper farthings.
   *
   * — because the server emits no `ESC[0m ESC[79D ESC[K` between the repainted
   * status line and the sentence, where before the deposit's sentence it does.
   * `STATUS_LINE` has no end anchor, so `status-line` claimed the whole line
   * and no rule written here could ever see the tail. `Classifier.classify`
   * now splits that tail and classifies it as a second block; see the note on
   * `tailAfterPrompt` there for what the corpus says about how often this
   * happens and what is in it.
   */
  {
    type: 'user-deposits',
    pattern: /^You deposit (?<amount>\d+) copper farthings\.$/
  },
  {
    type: 'user-withdraws',
    pattern: /^You withdrew (?<amount>\d+) copper farthings\.$/
  },

  /* ------------------------------------------------------------- room */
  /*
   * `health`, which is the only command that reports current *and* maximum
   * together. The stat sheet is the other source, and it takes a whole screen;
   * this is one line, so a rule can refresh a maximum cheaply.
   *
   * Anchored, and requiring `n/n`, so it cannot be confused with the stat
   * sheet's `Intellect: 45  Health:  45  Martial Arts: 14` — which carries the
   * *statistic* called Health, an entirely different number.
   */
  {
    type: 'user-health',
    pattern: /^Health:\s+(?<hp>\d+)\/(?<hpMax>\d+)\s+\[(?<percent>\d+)%\]/
  },

  { type: 'room-exits', pattern: /^Obvious exits: (?<exits>[\w, ]+)/, expectColour: [32] },
  { type: 'room-also-here', pattern: /^Also here: (?<who>.+?)\.?$/, expectColour: [35] },
  { type: 'room-items', pattern: /^You notice (?<items>.+?) here\.$/, expectColour: [36] },

  /*
   * Whether the room can be seen at all; 141 lines in 23 captures.
   *
   * **Four phrases, not three.** `pitch black` was measured live in
   * `1/2107 Labyrinth Passage` (light −999) and matched nothing, so the darkest
   * ninety-five rooms in the realm classified as `unknown` — and the tracker,
   * which clears the room only on a phrase it recognises, went on reporting the
   * room the character had been in *before*, with a full exit list and no
   * ambiguity. A confidently wrong location is the one answer this project
   * refuses.
   *
   * The alternation is built from `ROOM_LIGHTS` rather than restated, so the
   * union the tracker branches on and the pattern that produces it cannot
   * drift apart — the closed-union pairing this codebase has been bitten by
   * three times.
   *
   * `- you can't see anything` is optional because only the two blinding
   * phrases carry it.
   */
  {
    type: 'room-light',
    pattern: new RegExp(
      `^The room is (?<light>${ROOM_LIGHTS.join('|')})(?: - you can't see anything)?$`
    )
  },

  /*
   * Room name, last and loosest.
   *
   * There is no marker for it: it is simply the line before the description,
   * and it is a title-cased phrase, usually "Area, Place". Anchoring on shape
   * alone would swallow half the game's prose, so this rule leans on its
   * position in the table — everything with a real marker has already claimed
   * its line — plus a colour hint. `Classifier` additionally requires that a
   * room name be plausible in context; see `looksLikeRoomName`.
   */
  {
    type: 'room-name',
    /*
     * The separator is ", " or " " -- a single-character class misses the
     * comma-space in "Newhaven, Village Entrance", which is the commonest shape.
     *
     * A word may carry an abbreviating dot and `&` may join two halves, because
     * a great many real rooms are street corners: `Intersection of Guild St. &
     * River St.`. Measured against the 3,789 distinct names in the shipped realm
     * data, refusing those cost 2.6% of every room in the game -- and they are
     * concentrated in the starting city, where a character spends most of its
     * early life. `looksLikeRoomName` is what keeps the wider shape from
     * swallowing prose.
     */
    pattern: /^(?<name>[A-Z][\w'-]*\.?(?:(?:,\s+|\s+)(?:&|[A-Za-z][\w'-]*\.?))*)$/,
    expectColour: [36]
  }
];

/**
 * Multi-line blocks: a batch is recognised by a header, then every subsequent
 * line is offered to the qualifiers until the batch ends.
 *
 * `megamind-client` generalised this into array-shaped and object-shaped
 * batches; the same split is kept because `who` is a list of rows and the stat
 * sheet is one record spread over lines.
 */
export interface BatchRule {
  type: BlockType;
  /** Starts the batch. */
  header: RegExp;
  /** `array` accumulates a row per qualifier match; `object` merges groups. */
  shape: 'array' | 'object';
  qualifiers: RegExp[];
  /**
   * Whether a line that matches nothing continues the one before it.
   *
   * The server wraps its own output at a fixed width — it never negotiates
   * NAWS, so what arrives is wrapped where *it* decided, with a real CRLF at
   * the fold (docs/profiles.md §9.1). A carried inventory long enough to wrap
   * therefore arrives as two lines, and the second one belongs to the first:
   *
   *     You are carrying padded helm (Head), padded vest (Torso), padded gloves
   *     (Hands), padded pants (Legs), padded boots (Feet), quarterstaff (Weapon Hand)
   *
   * Opt-in per rule, and off by default, because it is only safe where the
   * block is *one record spread over lines*. Folding a stray line into a `who`
   * row would glue two adventurers together, and the loss there — a name
   * silently attached to somebody else's title — is worse than the wrap.
   *
   * `assemble` is the other shape of the same problem: a row whose *first*
   * fragment matches nothing either, because the fold landed before the part
   * that qualifies it. A wrapped party row arrives as a name on one line and
   * `(Bard)`, `[M: 70%] [H:100%]`, `- Midrank` on the next three. Lines are
   * joined until the result matches a qualifier, then closed, so the next
   * row starts fresh rather than being glued onto a completed one.
   */
  wraps?: boolean | 'assemble';
  /**
   * Whether a wrapped tail of this listing can look like a room name, so that
   * `room-name` is refused while the listing is open.
   *
   * Opt-in for one reason and one rule: the columnar `who` wraps a gang name
   * onto a line of its own — `Khazarad` — which is title case and one word,
   * and reading it as a room moved the character mid-listing. It is **not**
   * every folding listing: a poster's inventory in captures/111 runs to its
   * `maxLines` because that realm's prompt is not one the terminator knows,
   * and a real `Obsidian Tomb` arriving inside it lost its name — a stale
   * location that looks correct, which is worse than the false positive.
   */
  tailsLookLikeRooms?: boolean;
  /**
   * Maximum lines to keep collecting before giving up, or `'roster'` for a
   * listing whose length is the **realm's population** rather than a property
   * of the pattern.
   *
   * Every other listing here has a length the shape decides: eighteen worn
   * slots, a party of six, a stat sheet. A `who` has as many rows as there are
   * people logged in, which is the player's realm's business and not this
   * file's — and a cap set below it silently truncates the roster and then
   * feeds the rows past it back through the classifier one at a time. That
   * shipped as `60`, and on a realm with more adventurers than that it meant
   * a `who` listing somebody was looking at while the flyout said the person
   * was offline. `'roster'` reads `tuning.parse.rosterLines`, so somebody on a
   * busier realm changes a number rather than the client.
   */
  maxLines: number | 'roster';
}

/**
 * A row of the party listing, in the two shapes the server prints it.
 *
 * Shared by `party-roster` and `party-alone`, which are one listing under two
 * headers: the rows are identical, and a second copy of this pair is a second
 * place for the next shape to be added to only once.
 *
 * The **first** is somebody travelling — class, mana, health, status flag and
 * rank, all read out under `party-roster` below.
 *
 * The **second** is somebody *invited who has not accepted*, captured live
 * (2026-08-28) with the invitee standing a room away:
 *
 *     The following people are in your travel party:
 *       Vaelor                        (Mystic)     [M:100%] [H:100%]  - Frontrank
 *       Soul Guardian                 (Warrior)    [Invited]
 *
 * `[Invited]` stands where the health, the flag and the rank would be, and the
 * row matched nothing — so a listing of two fell to one row, and a party of one
 * is no party: the card **disappeared at the moment the invitation went out**,
 * which is the moment somebody is watching it for an answer. That is the
 * resting flag's lesson exactly, one field to the left: a shape that reads as
 * an absent field is usually a shape the server printed differently.
 */
const PARTY_ROWS: RegExp[] = [
  /^\s*(?<name>[A-Z][\w'-]*)(?: (?<last>[A-Z][\w'-]*))?\s*\((?<class>[\w ]+)\)\s*(?:\[(?<manaType>M|K):\s?(?<mana>\d+)%\]\s*)?\[H:\s?(?<health>\d+)%\]\s*(?<flag>[A-Za-z])?\s*-\s*(?<rank>\w+)\s*$/,
  /^\s*(?<name>[A-Z][\w'-]*)(?: (?<last>[A-Z][\w'-]*))?\s*\((?<class>[\w ]+)\)\s*\[(?<invited>Invited)\]\s*$/
];

/**
 * A row of the gang listing `bg` prints, captured from the live realm:
 *
 *     Valor members (2)
 *     Vaelor                        28 Half-Ogre Mystic       - Online [Leader]
 *     Soul Guardian                 1 Human Warrior           - Online
 *
 * `BroadgangCommand` in `GreaterMUD.Module` — the current variant of the three
 * trees on disk, and the one every extracted document is sourced from — formats
 * it as `{name,-29} {levelRaceClass,-25} {online,-8} {rank}`. Reproducing that
 * format string yields the capture above byte for byte, trailing space and all,
 * so the wire and the source agree and the columns below are the source's.
 *
 * **Read the right tree.** This docblock first claimed the wire and the source
 * *disagreed*, because the sibling `GreaterMUD/` and `GreaterMUD2/` trees do
 * print a three-field row with no level, race or class. Declaring the source
 * untrustworthy is what licensed not reading it further — and the 25-column
 * field below, which is a real parsing hazard, is stated plainly in the one
 * that matters.
 *
 * The C# local is called `lvlClassRaceString` and is built `Level + Race +
 * Class`; the *name* is wrong and the order is what the wire shows. Do not
 * "correct" the parser to match the variable.
 *
 * **Why this listing rather than `who`.** `who` states none of these: its row
 * carries the name, the *rank title*, the alignment and the gang, and nothing
 * else (`GMUDServer.cs`). The rank title is not the class — captures/076 has
 * one character whose `who` row says `Monk` and whose description says
 * `Mystic`, and `Monk` is not a class the realm data contains at all — so no
 * amount of reading `who` harder produces this. `bg` is the only listing that
 * names a gang's membership.
 *
 * And it is the only one that names the **whole** membership. `who` lists who
 * is logged in, so a gang member who is offline is not absent from it, they
 * are unrepresented in it; this listing enumerates the gang record itself and
 * marks each row `- Online` or leaves the field blank. That blank is the
 * offline half of the roster, and there is no other source for it.
 *
 * Three fields need care:
 *
 * - **The name may be two words.** `Soul Guardian` is a first name and a
 *   surname in a 29-column field, exactly as the party listing prints it, and
 *   a pattern that took one word would file two people under one name.
 * - **The race may be two words**, and so may a class. `Half-Ogre` is
 *   hyphenated and the realm also ships `Gaunt One`, so neither side can be
 *   read as a single token and the split cannot be made by counting words.
 *   What makes it unambiguous is the right-hand anchor: everything between the
 *   level and the `- Online`/rank field is `<race> <class>`, and the race is
 *   the *first* word of it unless the realm knows a two-word race — which is
 *   why the tracker resolves the pair against the realm's own race table
 *   rather than the pattern guessing at the boundary.
 * - **An offline member's field is empty, not absent.** The row keeps its
 *   column and simply has nothing in it, so `- Online` is optional and its
 *   absence is the statement that they are offline. Trailing whitespace is
 *   real: the second row above ends with a space where `[Leader]` would be.
 * - **The gap before `- Online` can be a single space.** The level/race/class
 *   field is padded to 25 and the format string puts one literal space after
 *   it, so a member whose field is *exactly* 25 characters — `100 Gaunt One
 *   Necromancer`, a max-level character of the realm's one two-word race —
 *   exhausts the padding. Requiring two spaces there dropped that row and only
 *   that row, in silence, which is the `[Invited]` failure from the party
 *   listing one field to the left: a shape that reads as an absent field is
 *   usually a shape the server printed differently. The separator before the
 *   *name* is the fixed-width one to anchor on; `\s+` is right after `<who>`.
 *
 * `[Captain]` and `[Lieutenant]` are in the same enum as `[Leader]`
 * (`GangMemberRank`) and are accepted here though no capture shows one; the
 * rank is kept verbatim and nothing is claimed about what it grants.
 */
const GANG_ROW =
  /^(?<name>[A-Z][\w'-]*)(?: (?<last>[A-Z][\w'-]*))?\s{2,}(?<level>\d+) (?<who>.+?)\s+(?:- (?<online>Online))?\s*(?:\[(?<rank>\w+)\])?\s*$/;

export const BATCH_RULES: BatchRule[] = [
  {
    /*
     * `bank`, standing in one. Live at the Bank of Godfrey (2026-08-29):
     *
     *     Your balance at Bank of Godfrey is:
     *     On deposit: 310335 copper farthings [3,103.35 gold crowns]
     *
     * A batch rather than two line rules because **`On deposit:` names
     * nothing**. It is the bare-figure shape — the account it describes is
     * recorded only by the line above it — so read independently it would be a
     * number with nowhere to go, and the consumer would have to re-correlate
     * the two, which is a batch reinvented badly.
     *
     * **The realm prints the bank three ways and only one of them is a key.**
     * The wire above says `Bank of Godfrey`; MajorMUD says `The Bank of
     * Godfrey (#8)` (captures/007:114); the realm data says `Bank of Godfrey`.
     * `(#8)` is the realm's own shop id — shop 8 in `rooms.jsonl.gz` is Bank
     * of Godfrey — so the optional group lifts it out as `shop` rather than
     * letting it become part of the name, and the leading `The` is stripped
     * for the same reason. Keying anything by the printed name would list one
     * bank twice for a character who banks on both realms, which is the
     * `sameItem` lesson: two parts of the server writing one list need not
     * agree on spelling.
     *
     * The name group is `.+?` and not a character class: the seven banks in
     * the shipped data have no punctuation, but the 228 shop names include
     * `Mariana's Clothing,, Back Room`, and a derivative may rename a bank
     * into that set. The lazy quantifier against the anchored `is:$` is what
     * makes the optional `(#N)` actually strip.
     *
     * **The copper integer is kept and the bracketed conversion is not.**
     * `[3,103.35 gold crowns]` is the server's own arithmetic over the same
     * total, exactly as `Wealth:` is over the five denominations, and storing
     * it would be a second copy of one fact. Note it is the *separated* figure
     * and the copper is not, so the group is `\d+` — a `[\d,]+` written "just
     * in case" is the one shape that could misread `3,103.35`.
     */
    type: 'bank-balance',
    header: /^Your balance at (?:The )?.+? is:$/,
    shape: 'object',
    maxLines: 4,
    qualifiers: [
      /^Your balance at (?:The )?(?<bank>.+?)(?: \(#(?<shop>\d+)\))? is:$/,
      /^On deposit:\s+(?<copper>\d+) copper farthings/
    ]
  },
  {
    /*
     * `i`. Captured from the live server:
     *
     *     You are carrying Nothing!
     *     You have no keys.
     *     Wealth: 0 copper farthings
     *     Encumbrance: 0/2400 - None [0%]
     *
     * `Encumbrance:` is the reliable terminator — it is always last.
     *
     * A carried list long enough to wrap arrives as two lines, and only the
     * first one begins `You are carrying`. Without `wraps` the tail was thrown
     * away silently: the Carrying card listed everything up to the fold and
     * stopped, which reads exactly like a character wearing half its kit.
     */
    type: 'user-inventory',
    header: /^You are carrying/,
    shape: 'object',
    wraps: true,
    maxLines: 20,
    qualifiers: [
      /^You are carrying (?<items>.+?)\.?$/,
      /^You have (?:the following keys: (?<keys>.+?)\.|no keys\.)/,
      /^Wealth:\s+(?<wealth>[\d,]+) copper farthings/,
      /^Encumbrance:\s+(?<encumbrance>\d+)\/(?<encumbranceMax>\d+)(?:\s+-\s+(?<encumbranceWord>[A-Za-z][A-Za-z ]*?))?(?:\s+\[|\s*$)/
    ]
  },
  {
    /*
     * `list`, in a shop. Captured from the live server:
     *
     *     The following items are for sale here:
     *
     *     Item                          Quantity    Price
     *     ------------------------------------------------------
     *     quarterstaff                  31           Free
     *     club                          26           Free (You can't use)
     *
     * Three columns and an optional parenthesised note, which is how the realm
     * says a class restriction. The qualifier is self-guarding: the `Item
     * Quantity Price` heading fails it because "Quantity" is not a number, and
     * the rule of dashes fails it for want of any column at all — so neither
     * needs excluding by hand.
     *
     * **The price is a word as often as a number.** `Free` is what this realm
     * prints for a starter shop, and reading it as zero would be inventing a
     * figure; it is kept verbatim and a consumer decides what to do with it.
     *
     * **And a priced row quotes a denomination**, live at Jael's Missile
     * Weapons (2026-08-27):
     *
     *     shortbow                      25          20 gold crowns (You can't use)
     *     runed longbow                 1           20 platinum pieces (You can't use)
     *
     * The first capture had only a starter shop, so the pattern took a bare
     * number and every priced row in a real shop failed the qualifier in
     * silence — the listing arrived and the face went on showing the realm
     * file. One or two words after the figure, any case, kept verbatim with
     * it: the noun is realm data (`copper drops to the ground` is one word,
     * captures/024 renames the runic coin), and a qualifier tuned to the one
     * shape seen is the party mana column's mistake again. `coins.ts`
     * converts for a comparison, never for display.
     */
    type: 'shop-list',
    header: /^The following items are for sale here:$/,
    shape: 'array',
    maxLines: 60,
    qualifiers: [
      /^(?<item>\S[^]*?)\s{2,}(?<quantity>\d+)\s+(?<price>Free|[\d,]+(?:\s+[A-Za-z]+(?:\s+[A-Za-z]+)?)?)(?:\s+\((?<note>[^)]+)\))?\s*$/
    ]
  },
  {
    /*
     * `who`. Captured from the live server:
     *
     *              Current Adventurers
     *              ===================
     *              Vaelor                -  Apprentice S
     *
     * The trailing letter is a status flag, not part of the title — gluing it
     * on was the first thing a real capture caught. The alignment column is
     * present only for characters that have one.
     *
     * **A gang follows the title as `of <gang>`.** Two realms, two spacings —
     * MajorMUD (captures/076, fifteen gangs on) puts two spaces before `of`,
     * and GreaterMUD (live, `npm run probe:who`, 2026-08-29) puts one:
     *
     *              Beaver IzCoo              -  Squire  of EyeExploredDora
     *         Good Crown Jewels              -  Acolyte  of Est? I'm on it?
     *              Khaine Rhayne             -  Spellslinger  of ~RaT HoUSe RaBBle~
     *              Vaelor                -  Kai Warrior of Mudengine S
     *              Rand                  -  Apprentice of Mudengine
     *
     * The seam is therefore ` of `, not the double space the corpus alone
     * suggested — the wire wins. A title is a class-and-rank string and none
     * in either realm contains `of`; the gang name is anything at all after
     * it. Glued into `title` it put `Squire  of EyeExploredDora` on the Realm
     * card as a rank, and — the half that mattered — left the only realm-wide
     * statement of gang membership read by nothing. The status flag stays
     * last, so a gang whose last word is one to three capitals would lose it
     * to `flags`: the same exposure a title has always had, and no gang seen
     * on either realm has that shape.
     *
     * The alignment column is eight wide and `Criminal` fills it, so that row
     * starts at the margin with no leading space (captures/076 again); the
     * old `^\s+` missed every Criminal in the realm.
     */
    type: 'who-list',
    header: /^\s*Current Adventurers\s*$/,
    shape: 'array',
    // As many rows as the realm has people: see `BatchRule.maxLines`. The
    // status line the server prints after the listing is what actually ends
    // this, and the cap is only the backstop for a realm whose prompt this
    // client has never met.
    maxLines: 'roster',
    qualifiers: [
      /^\s*(?:(?<alignment>Saint|Good|Neutral|Seedy|Outlaw|Criminal|Villain|Lawful|FIEND)\s+)?(?<name>[A-Z][\w'-]*)(?:\s+(?<last>[A-Z][\w'-]*))?\s+[-x]\s+(?<title>.+?)(?:\s+of (?<gang>.+?))?(?:\s+(?<flags>[A-Z]{1,3}))?\s*$/
    ]
  },
  {
    /*
     * `who` on a realm that prints it as columns (captures/003, captures/013 —
     * two MajorMUD realms), with the gang in a column of its own:
     *
     *     Title           Name                            Reputation Gang/Guild
     *     =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
     *     Guardian        Arcain OfKells                  Neutral    Dukes of
     *     Khazarad
     *     Magician        IceFairy ImCold                 Neutral
     *     FuryOfTheForgotten
     *     Woodsman        Monarth Lodune               ga Lawful     Bendyn Weyr
     *     Strider         Heretic Infidel                 Neutral    None
     *
     * The same record as `Current Adventurers`, so the same block type and the
     * same groups, and the tracker needs no second case. Two things this shape
     * has that the other does not: a gang name that **wraps** — sometimes mid
     * name, sometimes whole onto the next line — and a flag column before the
     * standing. Its letters are **lower case** (`ga`, `g`) where `Current
     * Adventurers` prints upper-case trailing ones (`S`), and what they mean
     * is not written down anywhere read: kept as `flags`, the way the party
     * listing keeps its unexplained `P`, and no condition is claimed from
     * them. A consumer that reads `S` must not read `g` as the same alphabet. `wraps: true` is what the wrap needs: a line that
     * matches no qualifier is folded onto the row above it, and here that is
     * safe where it is not for `Current Adventurers`, because every row has a
     * title and a name in columns and a bare `Khazarad` can only be a gang's
     * tail. `None` is the realm's word for no gang and the tracker reads it as
     * such. Classifying that tail as a *room name* — a live false positive that
     * moved the client's sense of location during a `who` — is refused while
     * this listing is open (`tailsLookLikeRooms`, read by `Classifier.matchLine`).
     *
     * **And that is the second cost of this rule's cap, which the other `who`
     * rule does not pay.** `maxLines: 'roster'` is right here for the same
     * reason it is right there — the length of a `who` is the realm's
     * population, and a cap below it truncated the roster and marked half the
     * realm offline. But while *this* batch is open no room name resolves at
     * all, so a realm whose prompt the terminator does not know now walks 400
     * lines without a location instead of 80. What holds it is the terminator
     * rather than the cap: it matches a lower-cased `[hp=` prompt as of
     * 2026-09-02, which is what the two realms in the corpus print, and both
     * of them therefore close on their own line rather than running out.
     */
    type: 'who-list',
    header: /^Title\s+Name\s+Reputation\s+Gang\/Guild\s*$/,
    shape: 'array',
    wraps: true,
    tailsLookLikeRooms: true,
    maxLines: 'roster',
    qualifiers: [
      /^(?<title>[A-Z][A-Za-z' -]*?)\s{2,}(?<name>[A-Z][\w'-]*)(?:\s+(?<last>[A-Za-z][\w'-]*))?\s+(?:(?<flags>[a-z]{1,3})\s+)?(?<alignment>Saint|Good|Neutral|Seedy|Outlaw|Criminal|Villain|Lawful|FIEND)(?:\s+(?<gang>\S.*?))?\s*$/
    ]
  },
  {
    /*
     * `party`. Captured live with two characters — the only way to see a row
     * that is not your own.
     *
     *     The following people are in your travel party:
     *       Vaelor                        (Warrior)             [H:100%]  - Frontrank
     *       Soul                          (Paladin)    [M:100%] [H:100%]  - Backrank
     *
     * **The mana column is optional**, exactly as it is in the status line and
     * for the same reason: a warrior has none. Reading one sample would have
     * produced a pattern that silently never matched a caster, or worse, one
     * that read a caster's mana as its health.
     *
     * This is the only place another character's health is visible at all, and
     * it costs one command rather than a second connection — which makes it the
     * most valuable thing on this server for a client running four characters.
     *
     * MajorMUD's listing is the same record with three differences, all seen in
     * 55 of 214 captures (docs/capture-analysis.md §5): a surname (`Slayer
     * OfSouls` — the only place a second name appears anywhere), a space after
     * the colon (`[M: 81%]`), `K:` for a mystic's kai and a third rank
     * (`Midrank`). And the rows wrap, which is what `assemble` is for.
     *
     * **A status flag sits between the health and the dash**, and it is what a
     * resting party member looks like:
     *
     *     Soul Guardian                 (Warrior)             [H:100%]R - Frontrank
     *
     * Unmatched, the row qualified as nothing, and a two-person roster with one
     * member resting fell to a single row — which the tracker reads as a party
     * of one, so the whole card *disappeared* the moment somebody sat down
     * (live, 2026-08-27). The letter is glued to the bracket or spaced off it
     * depending on the realm, and its meanings are decided in `partyActivity`,
     * not here.
     *
     * **The rank is required, and `assemble` is why.** It was optional on the
     * reading that MajorMUD prints an empty one — but every single row in the
     * corpus that ends at the dash has its rank on the *next* line, folded:
     *
     *     Azazyl Raines                  (Bard)       [M: 91%] [H: 43%] R -
     *     Backrank
     *
     * An optional rank closes that row at the fold, so the rank was lost and
     * the orphaned `Backrank` then swallowed the member below it. Requiring it
     * leaves the row open until the fold is rejoined, which is exactly the
     * state `assemble` exists to hold.
     */
    type: 'party-roster',
    header: /^The following people are in your travel party:$/,
    shape: 'array',
    wraps: 'assemble',
    maxLines: 24,
    qualifiers: PARTY_ROWS
  },
  {
    /*
     * The same listing when nobody else is in it. The server still prints your
     * own row, so the rows are read the same way — flag, folded rank and all —
     * and what differs is only that there is one.
     */
    type: 'party-alone',
    header: /^You are not in a party at the present time\.$/,
    shape: 'array',
    wraps: 'assemble',
    maxLines: 6,
    qualifiers: PARTY_ROWS
  },
  {
    /*
     * `bg` with no argument, captured from the live realm:
     *
     *     Valor members (2)
     *     Vaelor                        28 Half-Ogre Mystic       - Online [Leader]
     *     Soul Guardian                 1 Human Warrior           - Online
     *
     * The header states the gang's name and how many rows to expect, and the
     * count is the gang's *whole* membership rather than how many are on —
     * which is the point of reading this listing at all.
     *
     * `maxLines` is 64 because a gang is a standing organisation rather than a
     * party of six, and a listing cut off at its limit loses the tail in
     * silence. Nothing in the capture or the source caps the membership, so the
     * bound is chosen to be past any plausible one rather than to model a rule
     * the server has.
     *
     * **Not `wraps: 'assemble'`.** The party listing needs it because its rank
     * field folds; every field here is fixed-width and the rows in the capture
     * are 72 columns, well inside the width the server formats to. Folding
     * would glue two members into one, which is the failure `foldWraps`
     * documents for a `who` row.
     */
    type: 'gang-roster',
    header: /^(?<gang>.+?) members \((?<count>\d+)\)$/,
    shape: 'array',
    maxLines: 64,
    qualifiers: [GANG_ROW]
  },
  {
    /*
     * `look <player>`'s equipment block, one line per worn item:
     *
     *     He is equipped with:
     *
     *     gilded robes                   (Torso)
     *     padded pants                   (Legs)
     *     black and white serpent ring   (Finger)
     *
     * Sixteen corpus files carry one, all of them `He is`. **The header is
     * built from a gendered pronoun and the corpus would have misled us**:
     * `Player.cs:5379` composes it as `<subject pronoun> is|are equipped
     * with:`, and `Misc.GetGenderPronoun` gives `he`, `she`, `they` or `it` —
     * with `they` taking `are`. A pattern written from what the captures happen
     * to contain would have read a quarter of the realm and silently shown an
     * empty pack for everybody else.
     *
     * This is another player's *worn* kit and nothing more. What is in their
     * pack is not on the wire at any price — see `shared/players.ts`, which
     * had a field for it removed for exactly that reason — so the block is
     * named for what it is rather than called an inventory.
     *
     * The blank line after the header is why `maxLines` is generous: it is
     * inside the batch and matches no qualifier, which costs a line without
     * ending the block.
     */
    type: 'player-equipment',
    header: /^(?:He|She|It) is equipped with:$|^They are equipped with:$/,
    shape: 'array',
    maxLines: 24,
    /*
     * The slot may be **two words**. `(Weapon Hand)` is one, and a single-word
     * slot class dropped four of the thirty-six blocks in the corpus — losing
     * the weapon, which is the one item that decides what a fight with this
     * person looks like. Measured: 36 of 36 blocks parse with the space in,
     * across fifteen distinct slots.
     */
    qualifiers: [/^(?<item>.+?)\s{2,}\((?<slot>[A-Za-z][A-Za-z ]*)\)\s*$/]
  },
  {
    /*
     * The spells or powers this character knows — `sp` and `pow`, one grammar
     * under two headers. Captured live from both sides (`npm run
     * probe:spellbook`, 2026-09-01, orohost):
     *
     *     You have the following powers:
     *     Level Kai  Short Spell Name
     *       2   1    swan  way of the swan
     *      10   6    mant  way of the mantis
     *
     * and identically for `spells` with a `Mana` column; the corpus's one
     * spellbook (captures/056, MajorMUD, the full word `spells`) prints the
     * same header sentence, so the frame holds across both realms. The level
     * is right-aligned, the run-lengths are the server's own padding, and the
     * status line terminates the listing as it does every batch.
     *
     * The column header is a qualifier with no groups: consumed, no row.
     * Before this batch existed it was read as a *room name* — title-cased,
     * multi-word, so the loosest rule in the table took it — and every row
     * after it was swallowed as room description, live and in capture 056.
     */
    type: 'spellbook',
    header: /^You have the following (?<book>spells|powers):$/,
    shape: 'array',
    /*
     * The column header is title case and multi-word — exactly what
     * `looksLikeRoomName` accepts — so `room-name` is refused while this
     * listing is open, the columnar `who`'s rule. Without it the header
     * still classified as a room per line even while the batch collected,
     * and the tracker began a phantom draft mid-listing.
     */
    tailsLookLikeRooms: true,
    maxLines: 64,
    qualifiers: [
      /^Level (?:Mana|Kai)\s+Short Spell Name$/,
      /^\s*(?<level>\d{1,3})\s+(?<cost>\d{1,3})\s+(?<short>[\w'-]+)\s+(?<name>[\w' -]+?)\s*$/
    ]
  },
  {
    /*
     * What each level costs this character — the second half of `exp`, and the
     * only place the realm ever states it. Captured live on Paradigm from two
     * characters (2026-09-01 and 2026-09-03, `~/.config/mudengine/logs`), as
     * framed:
     *
     *     The following is a table of experience for your character:
     *
     *     Level   Experience
     *     -----   ----------
     *        2     7400
     *        3     14800
     *       ...
     *       11     934048
     *
     * Ten rows, from **one level below** this character's to eight above, so
     * the listing is a moving window rather than the whole table: a level-5
     * character's begins at 4. The rows accumulate as it moves, which is why
     * `withRealmExperience` merges rather than replaces.
     *
     * The blank line and the rule of dashes match no qualifier and are dropped;
     * the status line terminates it, as it does every batch. `maxLines` is 24
     * against the fifteen this realm sends — a realm printing a longer window
     * is read rather than truncated, and the cap is only the backstop.
     */
    type: 'user-experience-table',
    header: /^The following is a table of experience for your character:$/,
    shape: 'array',
    /*
     * `Level   Experience` is title case and multi-word — what
     * `looksLikeRoomName` accepts — so `room-name` is refused while this
     * listing is open, exactly as it is inside the spellbook and the columnar
     * `who`. Without it the column header begins a phantom room draft in the
     * middle of the table.
     */
    tailsLookLikeRooms: true,
    maxLines: 24,
    qualifiers: [/^Level\s+Experience$/, /^\s*(?<level>\d{1,3})\s+(?<experience>\d+)\s*$/]
  },
  {
    type: 'player-status',
    header: /^Name:\s+[\w\s]+\s+Lives\/CP:\s+\d+\/\d+/,
    shape: 'object',
    maxLines: 16,
    qualifiers: [
      /^Name:\s+(?<first>\w+) (?<last>\w*)\s+Lives\/CP:\s+(?<lives>\d+)\/(?<cp>\d+)/,
      /*
       * **The race may be two words.** `Gaunt One` is one of the thirteen the
       * shipped realm data names, and a single-token race did not merely lose
       * the name — the whole qualifier failed, so the *experience* and the
       * *perception* on that row went with it, for every character of that
       * race. Found in this client's own recorded sessions (2026-09-01,
       * Paradigm, a Gaunt One Mystic): the sheet was on screen and three of its
       * fields reached nothing. The gang listing already handles the same
       * hazard and says so; this row did not.
       *
       * Lazy, and anchored on `Exp:` — the race cannot swallow it, because
       * `[\w-]+` does not match the colon. The class stays one token: all
       * fifteen in every realm database on disk are one word, and a pattern
       * widened past its evidence is the guess this file exists to refuse.
       */
      /^Race:\s+(?<race>[\w-]+(?: [\w-]+)*?)\s+Exp:\s+(?<exp>\d+)\s+Perception:\s+(?<perception>\d+)/,
      /^Class:\s+(?<class>\w+)\s+Level:\s+(?<level>\d+)\s+Stealth:\s+(?<stealth>\d+)/,
      /^Hits:\s+(?<hp>\d+)\/(?<hpMax>\d+)\s+Armour Class:\s+(?<ac>\d+)\/(?<dr>\d+)\s+Thievery:\s+(?<thievery>\d+)/,
      /*
       * Which word carries the resource is kept, not just the numbers: `Kai:`
       * against `Mana:` is the sheet saying which listing this character owns
       * (`pow` against `sp`), the same fact the status line's `KAI=`/`MA=`
       * states — and the sheet says it even on a realm whose prompt omits it.
       */
      /^(?:(?<resourceWord>Mana|Kai):\s+(?<mana>\d+)\/(?<manaMax>\d+))?\s*(?:Spellcasting:\s+(?<spellcasting>\d+)\s+)?Traps:\s+(?<traps>\d+)/,
      /^\s*Picklocks:\s+(?<picklocks>\d+)/,
      /^Strength:\s+(?<strength>\d+)\s+Agility:\s+(?<agility>\d+)\s+Tracking:\s+(?<tracking>\d+)/,
      // Captured from the live server; the ported qualifiers did not have these.
      /^Intellect:\s+(?<intellect>\d+)\s+Health:\s+(?<health>\d+)\s+Martial Arts:\s+(?<martialArts>\d+)/,
      /^Willpower:\s+(?<willpower>\d+)\s+Charm:\s+(?<charm>\d+)\s+MagicRes:\s+(?<magicRes>\d+)/
    ]
  }
];
