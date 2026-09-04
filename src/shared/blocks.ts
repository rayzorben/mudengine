/**
 * The block vocabulary: what a line of server output can *mean*.
 *
 * Ported from `megamind-client/src/main/routines/classifier.js` and the ~55
 * block classes in the CoffeeScript `mudengine/src/blocks/`, which are the same
 * pattern set arrived at twice. See docs/reference-codebases.md §5.
 *
 * Two rules from docs/legacy-assessment.md §5 shape this:
 *
 * - **Grammar first, colour second.** Every rule matches on the *text* of a
 *   line. ANSI attributes are carried alongside as a confidence signal and are
 *   never the test. `megamind-client` decided a line was a room title because
 *   its span was bright cyan; that shatters on any server with a different
 *   scheme, and on every colour-blind theme.
 * - **Facts, not requests** (§6). A block says what the server said. Nothing
 *   here decides what to do about it.
 *
 * This module must stay dependency-free: the parser produces blocks in the main
 * process and the HUD consumes them in the renderer.
 */

/** Coarse grouping, so a consumer can subscribe to a whole domain. */
export type BlockDomain =
  | 'session'
  | 'status'
  | 'room'
  | 'combat'
  | 'conversation'
  | 'movement'
  | 'items'
  | 'stealth'
  | 'failure'
  | 'presence'
  | 'unknown';

export type BlockType =
  // session — the login sequence, and the in-game discriminator
  | 'prompt-username'
  | 'prompt-password'
  | 'prompt-new-password'
  | 'prompt-selection'
  | 'prompt-realm'
  | 'prompt-character'
  | 'prompt-menu'
  | 'login-failed'
  | 'login-welcome'
  /**
   * `You will exit after a period of silent meditation.` — the answer to `x`,
   * captured live (TODO.md). The character is leaving on purpose, which is
   * the one case automatic login must *not* answer the menu that follows.
   */
  | 'user-exits-realm'
  // status
  | 'status-line'
  | 'user-experience'
  /**
   * The table `exp` prints under `The following is a table of experience for
   * your character:` — ten rows, one level below this character's to eight
   * above, each the total experience that level costs.
   *
   * A separate type from `user-experience`, which is the one-line summary
   * printed by the same command: the summary states the *next* level's price
   * and nothing else, so a character several levels past the one the realm has
   * granted reads `Exp needed for next level: 0` and cannot say what it is
   * actually earning towards. Captured live on Paradigm, two characters,
   * 2026-09-01 and 2026-09-03 (`~/.config/mudengine/logs`).
   */
  | 'user-experience-table'
  | 'user-profile'
  | 'user-encumbrance'
  /** `health`: the one command that reports current *and* maximum together. */
  | 'user-health'
  /** `Welcome to level 2!` — the guild's answer to `train`, captured live. */
  /**
   * `You have been killed!` — this character's own death.
   *
   * Captured live and in the corpus, seventeen times, always as this sequence:
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
   * **A death is a teleport with no destination in it**, which is the whole
   * reason this is read: the room that follows is not where the last typed
   * command led, and attributing it to that command wrote `Learned: "nw" leads
   * from Darkwood Forest to Temple, Halls of the Dead` into a permanent
   * per-character file. See `Expectations.died`.
   */
  | 'user-dies'
  /**
   * `You have 8 lives left.` — the same number the stat sheet's `Lives/CP:`
   * gives, restated by the server at the one moment it changes.
   *
   * It appears only after a death, seventeen for seventeen across the corpus
   * and every recorded session. The maintained-listing shape: the sheet
   * establishes the figure, this keeps it true without spending a command.
   */
  | 'user-lives'
  | 'user-levels'
  /** `You hand over N copper farthings to train to the next level!` */
  | 'user-trains'
  /** `You have learned a new power way of the swan!` — what the level bought. */
  | 'user-learns'
  /**
   * `You add minor healing to your spellbook!` — a spell read off a scroll.
   *
   * A different event from `user-learns`, which is what a level bought, and it
   * differs in the half that is not in the sentence: the scroll is **spent**.
   * So it is its own type rather than a second spelling of that one — a client
   * that conflated them would either lose a scroll that was never read or keep
   * one that no longer exists.
   *
   * The sentence names the *spell* and never the item, which is deliberate on
   * the server's part and awkward here: `read minor` is a prefix the server
   * resolved, and `scroll of minor healing` appears in neither the command nor
   * the answer. `CharacterTracker` asks the realm which carried item teaches
   * this spell instead. Captured on the live realm 2026-09-03.
   */
  | 'user-reads-spell'
  /** `You gain 10 CPs` / `You gain 0 additional lives.` — the rest of the level. */
  | 'user-gains'
  | 'player-status'
  /**
   * `sp` / `pow` — the spells or powers this character knows, one row per
   * spell under `You have the following spells:` / `powers:`. Captured live
   * (`npm run probe:spellbook`, 2026-09-01) from both a KAI character and a
   * spellbook caster; the corpus's one occurrence (captures/056, MajorMUD,
   * the full word `spells`) prints the same header sentence. The header's
   * `book` group says which listing it was.
   */
  | 'spellbook'
  /**
   * The wrong book was asked for, and the server named the right one:
   * `You may not list your spells. You are KAI! You must list your powers.`
   * (and its mirror). Captured live with the listings. The `book` group is
   * the one the server says to ask for — what makes the ask self-correcting.
   */
  | 'spellbook-refused'
  | 'user-inventory'
  /**
   * `You have 22 platinum pieces, 50 gold crowns, 3 silver nobles, 4 copper
   * farthings.` — the answer to `wealth`, and the purse in **one line**.
   *
   * The same five facts the `i` listing carries, for a fifth of the output and
   * without the items. Found live 2026-08-28 by `npm run probe:tour`, which is
   * exactly what that probe is for: it was the only line of the whole run the
   * classifier could not type that was worth typing.
   */
  | 'user-wealth'
  | 'who-list'
  /** `party`, with somebody else in it. Carries a row per member. */
  | 'party-roster'
  /** `party`, alone. Still prints your own row. */
  | 'party-alone'
  /** Who this character is following, printed above the roster. */
  | 'party-following'
  // room
  | 'room-name'
  /** The prose paragraph under the room name. Has no marker of its own. */
  | 'room-description'
  | 'room-exits'
  | 'room-also-here'
  | 'room-items'
  /**
   * The same sentence, answering a **`search`** instead of a look.
   *
   * `You notice 4 copper farthings, scroll of minor healing here.` is what the
   * server prints for both, so nothing in the line separates them — the only
   * discriminator is which command it answers, which is why this type is
   * produced by `Classifier`'s own logic and has no pattern of its own.
   *
   * They are different facts and the difference is actionable. What a search
   * turns up **stays concealed**: a bare Enter after one reprints the room with
   * no `You notice` line at all, and the coins in it refuse a bare `get`.
   * Measured on the live realm 2026-09-02, the same room twice:
   *
   * ```
   * [HP=40/MA=8]:search
   * You notice 4 copper farthings, scroll of minor healing here.
   * [HP=40/MA=8]:get copper
   * You don't see any copper farthings
   * [HP=40/MA=8]:g 4 cop
   * You picked up 4 copper farthings
   * ```
   *
   * Seven of seven bare `get`s at searched-up coins were refused that way
   * across the recorded sessions, and every counted one was taken. Items are
   * unaffected — `get silver` off a search took `silver ring` — so it is the
   * **cash** that needs the quantity, which is what `AutoLoot` branches on.
   */
  | 'room-hidden-items'
  // combat
  | 'combat-status'
  | 'user-hits'
  | 'mob-hits'
  /**
   * A monster's attack on this character that did no damage.
   *
   * Named for the outcome rather than the sentence: what arrives is
   * `The large lashworm lunges at you!`, and whether that is a miss, a parry or
   * a swing the server chose not to score is not stated. What it settles is
   * that the thing is attacking, which is the fact retaliation turns on.
   */
  | 'mob-misses'
  /** This character's own swing that did not land. Names what it swung at. */
  | 'user-misses'
  /**
   * `He appears to be severely wounded.` — the answer to `look <mob>`.
   *
   * The **only** statement of a monster's health this server ever makes; there
   * is no number anywhere in the stream. It names no monster of its own, so it
   * is bound to whatever was last looked at. See `src/shared/wounds.ts`.
   */
  | 'mob-wounded'
  /**
   * The server refusing an attack this character cannot make.
   *
   * *"You don't know the first thing about bashing!"* and its four siblings.
   * Read out of `AttackCommand.cs` rather than seen on the wire, like the
   * conversation shapes below and for the same reason: producing one means
   * being a class that lacks the skill and typing it anyway, which is a thing
   * to *recognise* rather than a thing to go and do on a live realm.
   *
   * It matters because the refusal is printed in the room. A client that had
   * `bash` in its round list and no bashing would announce that once a round
   * for as long as the fight lasted, so this is what lets auto-combat drop the
   * verb and say so.
   */
  | 'attack-refused'
  /**
   * The attack is landing and achieving nothing — the wrong weapon entirely.
   *
   * *"Your weapon has no effect against this ...!"* docs/greatermud/combat.md
   * singles this out as the refusal that matters to automation: nothing else in
   * the stream says that a fight is unwinnable as it is being fought, and the
   * damage lines that would otherwise say so never arrive.
   */
  | 'attack-ineffective'
  | 'user-gain-experience'
  /**
   * `<Name> moves to attack you!` — a player opening on this character, and
   * the earliest warning there is: it arrives a full round before the first
   * damage line. 87 lines in 36 of 214 captures (docs/capture-analysis.md §3),
   * every one a player. The same sentence with somebody else as the target
   * settles what *everybody else* in the room is fighting, which is the input
   * to not opening a second fight on a monster a stranger already has.
   */
  | 'player-attacks'
  /**
   * A swing between two other parties — a player at a monster, a monster at a
   * player — that did not land. `Cercio swings at massive ice dragon!`,
   * `The giant wasp lunges at Caligula!`, and the armour-turned-it form
   * `Shooting's swing at ancient sand dragon hits, but glances off its
   * armour.` A sixth of everything the corpus left unread was this shape.
   */
  | 'player-misses'
  /**
   * `You have already cast a spell this round!` — the refusal that tells an
   * automated caster its timing is wrong. Cheap, unambiguous, and the one
   * piece of feedback the mid-round tick was missing.
   */
  | 'spell-refused'
  /**
   * A cast that names caster, spell and recipient: `You cast major healing on
   * Sir for 20 healing!`, `Naji casts mend on Naji!`, `Cass moves to cast
   * forked lightning upon whipvine.` The *effect* line that follows is
   * per-spell realm data and is read by the damage frame instead; this is the
   * half that says who healed whom, which is what the party card wants.
   */
  | 'spell-cast'
  /**
   * `You attempt to cast <spell>, but fail.` — the spellcasting roll failed
   * and nothing landed. Captured live 2026-09-03 (festus) and 60-odd times
   * across the corpus, first-person and targetless — **not** the third-person
   * `<caster> attempts to cast … on …, but fails.` that `docs/greatermud/combat.md`
   * read out of the server source and the wire has never shown. It is a fact,
   * not silence: a blessing that failed is a shield still down, so the recast
   * goes out on the next round rather than waiting the retry floor out.
   */
  | 'spell-failed'
  /**
   * `You feel safe from evil!` — the per-spell onset sentence, printed the
   * instant a duration spell lands. Its wording is realm message data no realm
   * database on hand exports, so it cannot be mapped to a spell *name* — but it
   * arrives immediately after this character's own cast confirmation, which
   * names the spell, so the pair is **learned** from that adjacency
   * (`CharacterTracker`, session-scoped). That learned map is what lets the
   * `st` sheet's `You feel safe from evil! (90s)` timer be attributed to the
   * right buff.
   */
  | 'spell-onset'
  /**
   * A duration spell ending on this character. Two frames, both from the
   * corpus: `The effects of <spell> wear(s) off!` (the generic one, 35 lines
   * across 16 spells) and `Your <spell> wears off.` / `The <spell> wears
   * off.` (per-spell endings that still keep the frame — `Your shield of
   * deflection wears off.`, `The song of soothing wears off.`). The fully
   * custom endings (`Your skin returns to normal.`, `The silvery aura
   * fades.`) are realm message data none of the realm databases on hand
   * export, so they cannot be enumerated and are deliberately not matched —
   * a buff whose ending the client cannot read is expired by a clock
   * instead: a party row's `fallbackSeconds`, or for the character's own
   * casts the duration measured from earlier cast→wear-off pairs.
   */
  | 'user-buff-expired'
  /** `You take 8 fire damage!` — damage with no attacker: a trap, a spell's aftermath, the room. */
  | 'user-takes-damage'
  /**
   * The realm's own conscience stopping an attack on a player: `You are
   * overcome with a feeling of guilt and break off your attack.` (captured
   * live, `npm run probe:pvp`) and the corpus's `To do this action, you must
   * turn off your evil warnings.` Both mean the character's evil warnings are
   * on, and `set warn` is what turns them off.
   */
  | 'attack-warned'
  /**
   * `set warn` toggling: `You will no longer be stopped from performing evil
   * actions.` / `You will now be warned and stopped from doing most evil
   * actions.` Captured live (`npm run probe:pvp`).
   */
  | 'user-warnings'
  /** `You are blind.` — a condition that decides whether to keep fighting. */
  | 'user-blinded'
  /** `You can see again!` */
  | 'user-blind-ends'
  /** `You are dizzy and disoriented from poison!` / `Poison burns through your veins!` */
  | 'user-poisoned'
  /** `The dizzying poison runs its course.` */
  | 'user-poison-ends'
  /** `You are inflicted with a hideous rotting disease!` */
  | 'user-diseased'
  /** `The disease dies down.` */
  | 'user-disease-ends'
  /** `Your legs are paralyzed!` / `You are held by …!` */
  | 'user-held'
  /** `You can move again!` */
  | 'user-held-ends'
  // conversation
  | 'conversation-gossip'
  | 'conversation-broadcast'
  | 'conversation-gangpath'
  | 'conversation-telepath'
  | 'conversation-auction'
  | 'conversation-directed'
  | 'conversation-yell'
  | 'conversation-local'
  /**
   * A command this server does not know, which it therefore *said out loud*.
   * See the note beside its pattern: this is a safety signal, not chatter.
   */
  | 'command-not-understood'
  // movement
  | 'comms-throttled'
  | 'direction-failed'
  | 'bash-failed'
  | 'heard-movement'
  /**
   * `The door is now open.` / `You successfully unlocked the door.` / `You
   * bashed the door open.` — the map's door annotations, and what `Walker`
   * waits on when it is forcing a barrier a route runs into.
   *
   * The two states are not interchangeable and the walker acts on the
   * difference: **bashed is open and picked is only unlocked.** A pick still
   * leaves a shut door, so `open` has to follow it; a bash does not, and does
   * not move the character either, so the direction has to follow that.
   */
  | 'door-changed'
  /**
   * `Your skill fails you this time.` — a skill was tried and did not work.
   *
   * Deliberately not named for picking. The server spends this one sentence on
   * a failed lock-pick *and* a failed trap disarm, and the words name neither;
   * whoever reads it supplies the context, which for `Walker` is "there is a
   * lock-pick in flight for the step I am standing at".
   */
  | 'skill-failed'
  /**
   * `Rend went west from here.` — the answer to `trac <name>`, and the only
   * mechanism in the game that says which way somebody went. A direction plus a
   * name against the world graph's exits is a pursuit route with no extra data.
   */
  | 'user-tracks'
  | 'user-tracks-failed'
  /**
   * ` -- Following your Party leader north --` — a move this character did not
   * type, captured live (`npm run probe:party`): the leader stepped and the
   * server walked the follower after them. The room that follows is a room
   * reached by a move, and the tracker has to be told which.
   */
  | 'party-follows'
  // items
  | 'user-hides'
  | 'player-gets'
  | 'player-drops'
  | 'user-equipped'
  | 'user-equipped-failed'
  | 'user-removed'
  /**
   * `Your torch flickers and goes out.` — a readied light has burnt down.
   * Captured live (2026-09-03, festus) and, as `Your lamp runs out of oil, and
   * goes out.`, in the corpus. Its own type rather than a removal: the torch
   * is still readied and still in the pack, and what changed is that it gives
   * no light, which is the `charges: 0` the listing would print as
   * `(Readied/0)`.
   */
  | 'light-out'
  | 'user-buys'
  | 'user-sells'
  /**
   * `bank`, standing in one: a header naming the bank and the figure it holds.
   *
   * Two lines and one record, so it is a batch — `On deposit: 310335 copper
   * farthings` names nothing at all, and read on its own it is a figure with
   * no account attached.
   */
  | 'bank-balance'
  /** `You deposit N copper farthings.` — the purse half of a banking round. */
  | 'user-deposits'
  /**
   * `You withdrew N copper farthings.` — the other half, in the past tense.
   *
   * The tense is the point: the symmetry with the deposit's sentence would
   * have given `You withdraw`, and it is wrong. The server also prints it on
   * the **same framed line as the prompt** — `[HP=334/KAI=27]:You withdrew
   * 7984 copper farthings.` — which is why `Classifier` splits a prompt's
   * tail before this can ever match. Captured live, `npm run probe:bank`.
   */
  | 'user-withdraws'
  | 'user-list'
  | 'shop-list'
  /**
   * `18 gold drop to the ground.` — coins landing on the floor when something
   * dies. They are loot the room's item list should carry, and the thing every
   * MegaMUD-era script picks up first.
   */
  | 'room-coins'
  /**
   * `You picked up 17 copper farthings` — coins off the floor, captured live
   * (`npm run probe:play`). Coins go to wealth, not the pack, and the sentence
   * has no full stop; a separate type from `player-gets` so nothing tries to
   * put "17 copper farthings" in the pack listing.
   */
  | 'user-gets-coins'
  // stealth
  | 'user-sneaking'
  | 'user-not-sneaking'
  | 'user-sneak-failed'
  | 'user-sneak-initiate'
  | 'user-cant-sneak'
  /*
   * Hiding is sneaking's twin — the same mechanic, standing still — and the
   * client had the whole sneak vocabulary and none of this. `Attempting to
   * hide...` is an attempt, not an outcome, for exactly the reason the sneak
   * note gives; the corpus never shows the success line, so none is invented.
   */
  | 'user-hide-initiate'
  | 'user-hide-failed'
  | 'user-cant-hide'
  // failure
  | 'command-no-effect'
  /**
   * `You don't see soul here.` — the twin of `command-no-effect` that *names*
   * the thing that is not there, in the spelling the player typed. Captured
   * live (`npm run probe:party`, an `invite` a room too early).
   *
   * The server ships **three** spellings of it, two of them read out of its own
   * source rather than captured: `You do not see <x> here!` from `LookCommand`
   * and `You don't see <x> here!` elsewhere, beside the captured full stop.
   */
  | 'target-missing'
  /**
   * `You may not do that while you are mortally wounded!` — the server
   * refusing **whatever was sent**, and naming the condition rather than the
   * command.
   *
   * Measured, not guessed: 33,402 of these across the recorded sessions and
   * **not one of them read**, which makes it comfortably the most common
   * sentence this client has never understood. 33,396 are one session
   * (`2026-09-01_21-49-21_festus`) in which a character sat at `[HP=-21]` while
   * automation sent an attack every few milliseconds, each refused, until it
   * died.
   *
   * It is read for the reason the toll refusal and `You are blind.` were: **a
   * refusal nobody reads strands the move it answered.** A step sent while
   * mortally wounded is refused by this and by nothing else, so its claim sat
   * outstanding — measured at 126 seconds in that same session — and
   * `pendingMoves` gates the escape, `Walker.start`, a loop's next leg and
   * hitting back. The one moment a character most needs to run is the one this
   * silently took the escape away in.
   */
  | 'command-refused'
  /**
   * `Please be more specific.  You could have meant any of these:` — a look or
   * a command whose argument reached more than one thing.
   *
   * Read out of `LookCommand.cs` rather than captured, and read for exactly one
   * reason: **it means no wound sentence is coming.** A refused look leaves its
   * entry in the look queue, and the next wound line to arrive would bind to
   * it — one monster's condition on another's bar, the reassuring-direction
   * failure the queue exists to prevent.
   *
   * The sentence names nothing; the candidates follow on their own lines. There
   * is no reason to read them, so none are captured.
   */
  | 'target-ambiguous'
  /** `That is not a door or a gate!` — `open` aimed at a wall. Captured live (`npm run probe:stealth`). */
  | 'open-failed'
  /** `You cannot LIST if you are not in a shop!` — captured live, the same run. */
  | 'user-list-failed'
  | 'command-ignored'
  | 'slow-down'
  | 'user-search-failed'
  | 'user-search-succeeded'
  // presence
  | 'player-enters'
  /** `look <player>`'s first line: `[ Name Last ] (Gang)`, the gang optional. */
  | 'player-look'
  /**
   * `bg` with no argument: the gang's whole membership, one row each.
   *
   * The only listing that names a gang's members, and the only one that
   * includes the **offline** ones — `who` states who is logged in, so somebody
   * who is not is unrepresented in it rather than absent from it. It is also
   * the only source of another player's level, race and class.
   */
  | 'gang-roster'
  /**
   * Somebody joined or left this character's gang, broadcast to every member.
   *
   * A permission fact as much as a presence one: the gang grant answers `@`
   * commands for whoever shares the gang, so these are what make a departure
   * take effect before the next `who`.
   */
  | 'gang-joined'
  | 'gang-left'
  /** `gb` from a character in no gang. */
  | 'gang-none'
  /**
   * The equipment block from a `look` at another player — what they are
   * *wearing*, which is the whole of what this server says about another
   * player's belongings. What is carried is not on the wire at any price.
   */
  | 'player-equipment'
  | 'player-exits'
  | 'player-disconnects'
  /**
   * Somebody walking into, or out of, *this room* — as opposed to the realm.
   *
   * A different fact from `player-enters`, and the more urgent one: the realm
   * is large and this room is where a fight happens.
   */
  | 'player-arrives-room'
  | 'player-leaves-room'
  /**
   * A *monster* walking into this room.
   *
   * Separate from `player-arrives-room` because the two sentences come from
   * different halves of the server — a player's is composed in `Player.cs`, a
   * monster's out of realm data — and because what each one means to the client
   * is different: one is somebody to be wary of, the other is something to
   * fight, and only one of them belongs in the room's monster count.
   */
  | 'mob-arrives-room'
  /**
   * `<Name> is looking around the room.` / `is looking at you.` — somebody
   * sizing the room up, which on a PvP realm is the moment before something
   * happens. Captured live (`npm run probe:pvp`) and in the corpus.
   */
  | 'player-looks'
  /** `The room is barely visible` / `dimly lit` — whether the occupants can be seen at all. */
  | 'room-light'
  /**
   * `You are blind.` — the server declining to print a room at all.
   *
   * Not the onset of blindness, which is `You are blind!` with a bang and
   * arrives beside the attack that caused it (`user-blinded`). This is what
   * the server substitutes for **every** room it would otherwise have drawn
   * while the condition holds: a bare Enter, a `look`, a `look <mob>`, a peek
   * down an exit, and — the one that costs something — a *move*. Thirty-one of
   * them across three captures, every one immediately after a status line, and
   * the arrival case is captured twice over: `captures/007` opens a door
   * north, sends `n`, is answered with this alone and afterwards closes the
   * same door to the *south*; and the player's own log of 2026-09-01 falls
   * into a pit on `nw` and finds itself at `1,1765` when it later asks.
   *
   * So it is a room block, in the room domain, and not a status one: it is the
   * answer to a command, it consumes the move it answers, and read as anything
   * else it leaves that move outstanding for ever. See `room-light`, which is
   * the same shape for a room too dark to describe rather than a character too
   * blind to read it.
   */
  | 'room-unseen'
  /** `Trickster drops to the ground!` / `Rend is dead.` — a player's death, composed in `Player.cs` rather than from realm data. */
  | 'player-dies'
  /** `Kaylon stops to rest.` / `kneels to meditate.` — a party member's state, volunteered. */
  | 'player-rests'
  /** `You are now resting.` — the rest the status line will confirm on its next repaint. */
  | 'user-rests'
  /* Party membership, announced rather than asked for. */
  | 'party-invited'
  | 'party-joined'
  | 'party-left'
  | 'party-rank-changed'
  /** The server echoing back the command we just sent. */
  | 'command-echo'
  // fallback
  | 'unknown';

/** One classified line. */
export interface Block {
  /** Sequence of the `StreamLine` it came from. */
  seq: number;
  at: number;
  type: BlockType;
  domain: BlockDomain;
  /** Named capture groups from the matching pattern. */
  groups: Record<string, string>;
  /** The plain text that was matched. */
  text: string;
  /**
   * 0–1. Text match alone is 0.8; agreeing ANSI colour raises it, disagreeing
   * colour lowers it. Never a gate — a rule that only fires on the right colour
   * is a rule that breaks on the next server.
   */
  confidence: number;
}

const DOMAIN_OF: Record<BlockType, BlockDomain> = {
  'prompt-username': 'session',
  'prompt-password': 'session',
  'prompt-new-password': 'session',
  'prompt-selection': 'session',
  'prompt-realm': 'session',
  'prompt-character': 'session',
  'prompt-menu': 'session',
  'login-failed': 'session',
  'login-welcome': 'session',
  'user-exits-realm': 'session',

  'status-line': 'status',
  'user-experience': 'status',
  'user-experience-table': 'status',
  'user-profile': 'status',
  'user-encumbrance': 'status',
  'user-health': 'status',
  'user-dies': 'presence',
  'user-lives': 'status',
  'user-levels': 'status',
  'user-trains': 'status',
  'user-learns': 'status',
  'user-reads-spell': 'status',
  'user-gains': 'status',
  'player-status': 'status',
  spellbook: 'status',
  'spellbook-refused': 'status',
  'user-inventory': 'status',
  'user-wealth': 'status',
  'who-list': 'status',
  'party-roster': 'status',
  'party-alone': 'status',
  'party-following': 'status',

  'room-name': 'room',
  'room-description': 'room',
  'room-exits': 'room',
  'room-also-here': 'room',
  'room-items': 'room',
  'room-hidden-items': 'room',

  'combat-status': 'combat',
  'user-hits': 'combat',
  'mob-hits': 'combat',
  'mob-misses': 'combat',
  'user-misses': 'combat',
  'mob-wounded': 'combat',
  'attack-refused': 'combat',
  'attack-ineffective': 'combat',
  'user-gain-experience': 'combat',
  'player-attacks': 'combat',
  'player-misses': 'combat',
  'spell-refused': 'combat',
  'spell-cast': 'combat',
  'spell-failed': 'combat',
  'spell-onset': 'combat',
  'user-buff-expired': 'status',
  'user-takes-damage': 'combat',
  'attack-warned': 'combat',
  'user-warnings': 'status',
  'user-blinded': 'status',
  'user-blind-ends': 'status',
  'user-poisoned': 'status',
  'user-poison-ends': 'status',
  'user-diseased': 'status',
  'user-disease-ends': 'status',
  'user-held': 'status',
  'user-held-ends': 'status',

  'conversation-gossip': 'conversation',
  'conversation-broadcast': 'conversation',
  'conversation-gangpath': 'conversation',
  'conversation-telepath': 'conversation',
  'conversation-auction': 'conversation',
  'conversation-directed': 'conversation',
  'conversation-yell': 'conversation',
  'conversation-local': 'conversation',
  // Grouped with failures rather than conversation: what it reports is that a
  // command did not run, and the broadcast is the consequence.
  'command-not-understood': 'failure',

  'comms-throttled': 'failure',
  'direction-failed': 'movement',
  'bash-failed': 'movement',
  'heard-movement': 'movement',
  'door-changed': 'movement',
  'skill-failed': 'movement',
  'user-tracks': 'movement',
  'user-tracks-failed': 'movement',
  'party-follows': 'movement',

  'user-hides': 'items',
  'player-gets': 'items',
  'player-drops': 'items',
  'user-equipped': 'items',
  'user-equipped-failed': 'items',
  'user-removed': 'items',
  'light-out': 'items',
  'user-buys': 'items',
  'user-sells': 'items',
  'bank-balance': 'items',
  'user-deposits': 'items',
  'user-withdraws': 'items',
  'user-list': 'items',
  'shop-list': 'items',
  'room-coins': 'items',
  'user-gets-coins': 'items',

  'user-sneaking': 'stealth',
  'user-not-sneaking': 'stealth',
  'user-sneak-failed': 'stealth',
  'user-sneak-initiate': 'stealth',
  'user-cant-sneak': 'stealth',
  'user-hide-initiate': 'stealth',
  'user-hide-failed': 'stealth',
  'user-cant-hide': 'stealth',

  'command-no-effect': 'failure',
  'command-refused': 'failure',
  'target-missing': 'failure',
  'target-ambiguous': 'failure',
  'open-failed': 'failure',
  'user-list-failed': 'failure',
  'command-ignored': 'failure',
  'slow-down': 'failure',
  'user-search-failed': 'failure',
  'user-search-succeeded': 'failure',

  'player-enters': 'presence',
  'player-look': 'presence',
  'gang-roster': 'presence',
  'gang-joined': 'presence',
  'gang-left': 'presence',
  'gang-none': 'presence',
  'player-equipment': 'presence',
  'player-exits': 'presence',
  'player-disconnects': 'presence',
  'player-arrives-room': 'presence',
  'player-leaves-room': 'presence',
  'mob-arrives-room': 'presence',
  'room-light': 'room',
  'room-unseen': 'room',
  'player-looks': 'presence',
  'player-dies': 'presence',
  'player-rests': 'presence',
  'user-rests': 'status',
  'party-invited': 'presence',
  'party-joined': 'presence',
  'party-left': 'presence',
  'party-rank-changed': 'presence',

  'command-echo': 'session',

  unknown: 'unknown'
};

export function domainOf(type: BlockType): BlockDomain {
  return DOMAIN_OF[type];
}
