/**
 * The realm's command vocabulary, and what each command can do to the client's
 * idea of where the character is standing.
 *
 * Extracted whole from `GreaterMUD.Module/PlayerCommands/Commands.cs` — a
 * single dictionary mapping every accepted word to a `CommandType` — and
 * transcribed in [docs/greatermud/commands.md](../../docs/greatermud/commands.md).
 * 94 commands, 325 words. It is a **table**, not a rule: the server does no
 * prefix matching at all, so `loo` is accepted and `lk` is not, `sc` is `who`,
 * and `bash` also answers to `aa` and `allout`. Anything that infers a command
 * from a prefix is wrong in both directions.
 *
 * ## Why the client needs it
 *
 * `WorldMemory` learns a way through the realm by noticing that the character
 * ended up somewhere the realm data has no edge to — and it needs to know
 * *which command did that*. Before this table it assumed any command it did
 * not model as movement might have been the one, which produced two false
 * records in a single evening's play:
 *
 * ```
 * [HP=34]: sys go 5 1
 * │ Learned: "sys go 5 1" leads from Newhaven, Narrow Road to Town Gates, Inner Bailey.
 * [HP=34]: l
 * │ Learned: "l" leads from Town Gates, Inner Bailey to Town Gates, Inner Bailey.
 * ```
 *
 * Neither is a way through anything. `l` cannot move a character at all, and
 * `sys go` teleports by room number along no edge a player could ever walk.
 * Both were written to a permanent per-character file, and a route planned
 * through one sends somebody somewhere they may not get back from.
 *
 * So the question is asked the other way round now: **a command the realm's own
 * table names is a command the realm's own table says the effect of**, and only
 * `Move` moves. What is left over — a word the table does not have — is the one
 * thing a text exit can be (`go crimson portal`, `enter manhole`: there is no
 * `Go` or `Enter` in `Commands.cs`, because those are room data), and that is
 * the only shape worth learning from.
 *
 * Dependency-free, like everything in `shared/`: the parser classifies outbound
 * commands with it in main, and the settings screen and the palette can name
 * commands with it in the renderer.
 */

/** One entry of the server's command table. Its `CommandType`, verbatim. */
export type CommandName =
  | 'Abilities'
  | 'Action'
  | 'Aid'
  | 'Appraise'
  | 'Ask'
  | 'Attack'
  | 'Auction'
  | 'Backrank'
  | 'BackStab'
  | 'Bank'
  | 'Bash'
  | 'Break'
  | 'Brief'
  | 'Broadcast'
  | 'Broadgang'
  | 'Buy'
  | 'Cast'
  | 'Close'
  | 'Create'
  | 'Deaths'
  | 'Demote'
  | 'Deposit'
  | 'Disarm'
  | 'Disband'
  | 'Drag'
  | 'Drink'
  | 'Drop'
  | 'Equip'
  | 'Exit'
  | 'Experience'
  | 'Follow'
  | 'Forgive'
  | 'Frontrank'
  | 'Get'
  | 'Give'
  | 'Gossip'
  | 'Health'
  | 'Help'
  | 'Hide'
  | 'Ignore'
  | 'Inventory'
  | 'Invite'
  | 'Join'
  | 'Jumpkick'
  | 'Kick'
  | 'Leave'
  | 'Light'
  | 'List'
  | 'Lock'
  | 'Look'
  | 'Map'
  | 'Meditate'
  | 'Midrank'
  | 'Move'
  | 'NParty'
  | 'Open'
  | 'Party'
  | 'Pick'
  | 'Pow'
  | 'Profile'
  | 'Promote'
  | 'Punch'
  | 'Purge'
  | 'Pvp'
  | 'Read'
  | 'Recover'
  | 'Remove'
  | 'Reroll'
  | 'Rest'
  | 'Rob'
  | 'Roll'
  | 'Room'
  | 'Search'
  | 'Sell'
  | 'Set'
  | 'Share'
  | 'Smash'
  | 'Sneak'
  | 'Spells'
  | 'Stash'
  | 'Stat'
  | 'Stock'
  | 'Suicide'
  | 'Sys'
  | 'Top'
  | 'Track'
  | 'Train'
  | 'Uninvite'
  | 'Unstock'
  | 'Use'
  | 'Verbose'
  | 'Wealth'
  | 'Who'
  | 'Withdraw';

/**
 * Every word the server accepts, and the command it reaches.
 *
 * Transcribed by hand from the extracted table rather than computed from the
 * command names, because the server's own dictionary is hand-written: `sc`,
 * `sca` and `scan` all reach `Who`; `ready`, `arm` and `wear` all reach
 * `Equip`; `bs` is the only spelling of `BackStab`; and `as` is `Ask` rather
 * than an abbreviation of anything beginning with "as".
 */
export const COMMAND_WORDS: Readonly<Record<string, CommandName>> = {
  // Abilities
  ab: 'Abilities',
  abi: 'Abilities',
  abil: 'Abilities',
  abili: 'Abilities',
  abilit: 'Abilities',
  abiliti: 'Abilities',
  abilitie: 'Abilities',
  abilities: 'Abilities',
  // Action
  ac: 'Action',
  act: 'Action',
  acti: 'Action',
  actio: 'Action',
  action: 'Action',
  actions: 'Action',
  // Aid
  aid: 'Aid',
  // Appraise
  app: 'Appraise',
  appr: 'Appraise',
  appra: 'Appraise',
  apprai: 'Appraise',
  apprais: 'Appraise',
  appraise: 'Appraise',
  // Ask
  ask: 'Ask',
  as: 'Ask',
  greet: 'Ask',
  // Attack
  a: 'Attack',
  at: 'Attack',
  att: 'Attack',
  atta: 'Attack',
  attac: 'Attack',
  attack: 'Attack',
  // Auction
  auc: 'Auction',
  auct: 'Auction',
  aucti: 'Auction',
  auctio: 'Auction',
  auction: 'Auction',
  // Backrank
  back: 'Backrank',
  backr: 'Backrank',
  backra: 'Backrank',
  backran: 'Backrank',
  backrank: 'Backrank',
  // BackStab
  bs: 'BackStab',
  // Bank
  ban: 'Bank',
  bank: 'Bank',
  bankb: 'Bank',
  bankbo: 'Bank',
  bankboo: 'Bank',
  bankbook: 'Bank',
  bal: 'Bank',
  bala: 'Bank',
  balan: 'Bank',
  balanc: 'Bank',
  balance: 'Bank',
  // Bash
  aa: 'Bash',
  all: 'Bash',
  allo: 'Bash',
  allou: 'Bash',
  allout: 'Bash',
  bas: 'Bash',
  bash: 'Bash',
  // Break
  bre: 'Break',
  brea: 'Break',
  break: 'Break',
  // Brief
  bri: 'Brief',
  brie: 'Brief',
  brief: 'Brief',
  // Broadcast
  br: 'Broadcast',
  bro: 'Broadcast',
  broa: 'Broadcast',
  broad: 'Broadcast',
  broadc: 'Broadcast',
  broadca: 'Broadcast',
  broadcas: 'Broadcast',
  broadcast: 'Broadcast',
  // Broadgang
  bg: 'Broadgang',
  broadg: 'Broadgang',
  broadga: 'Broadgang',
  broadgan: 'Broadgang',
  broadgang: 'Broadgang',
  gb: 'Broadgang',
  // Buy
  bu: 'Buy',
  buy: 'Buy',
  // Cast
  c: 'Cast',
  ca: 'Cast',
  cas: 'Cast',
  cast: 'Cast',
  // Close
  cl: 'Close',
  clo: 'Close',
  clos: 'Close',
  close: 'Close',
  // Create
  create: 'Create',
  // Deaths
  dea: 'Deaths',
  deat: 'Deaths',
  death: 'Deaths',
  deaths: 'Deaths',
  // Demote
  demote: 'Demote',
  // Deposit
  dep: 'Deposit',
  depo: 'Deposit',
  depos: 'Deposit',
  deposi: 'Deposit',
  deposit: 'Deposit',
  // Disarm
  disarm: 'Disarm',
  // Disband
  disb: 'Disband',
  disba: 'Disband',
  disban: 'Disband',
  disband: 'Disband',
  // Drag
  drag: 'Drag',
  // Drink
  dri: 'Drink',
  drin: 'Drink',
  drink: 'Drink',
  // Drop
  dr: 'Drop',
  dro: 'Drop',
  drop: 'Drop',
  // Equip
  eq: 'Equip',
  equ: 'Equip',
  equi: 'Equip',
  equip: 'Equip',
  ar: 'Equip',
  arm: 'Equip',
  wea: 'Equip',
  wear: 'Equip',
  ready: 'Equip',
  // Exit
  exit: 'Exit',
  x: 'Exit',
  ';o': 'Exit',
  ';x': 'Exit',
  // Experience
  exp: 'Experience',
  experience: 'Experience',
  // Follow
  fol: 'Follow',
  foll: 'Follow',
  follo: 'Follow',
  follow: 'Follow',
  // Forgive
  forgive: 'Forgive',
  // Frontrank
  fr: 'Frontrank',
  fro: 'Frontrank',
  fron: 'Frontrank',
  front: 'Frontrank',
  frontr: 'Frontrank',
  frontra: 'Frontrank',
  frontran: 'Frontrank',
  frontrank: 'Frontrank',
  // Get
  g: 'Get',
  ge: 'Get',
  get: 'Get',
  // Give
  gi: 'Give',
  giv: 'Give',
  give: 'Give',
  // Gossip
  gos: 'Gossip',
  goss: 'Gossip',
  gossi: 'Gossip',
  gossip: 'Gossip',
  // Health
  hea: 'Health',
  heal: 'Health',
  healt: 'Health',
  health: 'Health',
  // Help
  '?': 'Help',
  help: 'Help',
  // Hide
  hid: 'Hide',
  hide: 'Hide',
  // Ignore
  ignore: 'Ignore',
  // Inventory
  i: 'Inventory',
  in: 'Inventory',
  inv: 'Inventory',
  inventory: 'Inventory',
  // Invite
  invi: 'Invite',
  invit: 'Invite',
  invite: 'Invite',
  // Join
  jo: 'Join',
  joi: 'Join',
  join: 'Join',
  // Jumpkick
  ju: 'Jumpkick',
  jum: 'Jumpkick',
  jump: 'Jumpkick',
  jumpk: 'Jumpkick',
  jumpki: 'Jumpkick',
  jumpkic: 'Jumpkick',
  jumpkick: 'Jumpkick',
  // Kick
  ki: 'Kick',
  kic: 'Kick',
  kick: 'Kick',
  // Leave
  le: 'Leave',
  lea: 'Leave',
  leav: 'Leave',
  leave: 'Leave',
  // Light
  lig: 'Light',
  ligh: 'Light',
  light: 'Light',
  // List
  lis: 'List',
  list: 'List',
  // Lock
  loc: 'Lock',
  lock: 'Lock',
  // Look
  l: 'Look',
  lo: 'Look',
  loo: 'Look',
  look: 'Look',
  // Map
  map: 'Map',
  // Meditate
  med: 'Meditate',
  medi: 'Meditate',
  medit: 'Meditate',
  medita: 'Meditate',
  meditat: 'Meditate',
  meditate: 'Meditate',
  // Midrank
  mi: 'Midrank',
  mid: 'Midrank',
  midr: 'Midrank',
  midra: 'Midrank',
  midran: 'Midrank',
  midrank: 'Midrank',
  // Move
  n: 'Move',
  ne: 'Move',
  e: 'Move',
  se: 'Move',
  s: 'Move',
  sw: 'Move',
  w: 'Move',
  nw: 'Move',
  u: 'Move',
  up: 'Move',
  d: 'Move',
  down: 'Move',
  // NParty
  npar: 'NParty',
  nparty: 'NParty',
  // Open
  op: 'Open',
  ope: 'Open',
  open: 'Open',
  // Party
  par: 'Party',
  part: 'Party',
  party: 'Party',
  // Pick
  pi: 'Pick',
  pic: 'Pick',
  pick: 'Pick',
  // Pow
  po: 'Pow',
  pow: 'Pow',
  powe: 'Pow',
  power: 'Pow',
  powers: 'Pow',
  // Profile
  pr: 'Profile',
  pro: 'Profile',
  prof: 'Profile',
  profi: 'Profile',
  profil: 'Profile',
  profile: 'Profile',
  // Promote
  promote: 'Promote',
  // Punch
  pu: 'Punch',
  pun: 'Punch',
  punc: 'Punch',
  punch: 'Punch',
  // Purge
  purge: 'Purge',
  // Pvp
  pvp: 'Pvp',
  pvps: 'Pvp',
  pvpsc: 'Pvp',
  pvpsco: 'Pvp',
  pvpscor: 'Pvp',
  pvpscore: 'Pvp',
  // Read
  read: 'Read',
  // Recover
  recover: 'Recover',
  // Remove
  rem: 'Remove',
  remo: 'Remove',
  remov: 'Remove',
  remove: 'Remove',
  // Reroll
  reroll: 'Reroll',
  // Rest
  rest: 'Rest',
  // Rob
  rob: 'Rob',
  // Roll
  roll: 'Roll',
  // Room
  room: 'Room',
  roo: 'Room',
  rm: 'Room',
  // Search
  sea: 'Search',
  sear: 'Search',
  searc: 'Search',
  search: 'Search',
  // Sell
  sell: 'Sell',
  // Set
  set: 'Set',
  // Share
  sha: 'Share',
  shar: 'Share',
  share: 'Share',
  // Smash
  sm: 'Smash',
  sma: 'Smash',
  smas: 'Smash',
  smash: 'Smash',
  // Sneak
  sn: 'Sneak',
  sne: 'Sneak',
  snea: 'Sneak',
  sneak: 'Sneak',
  // Spells
  sp: 'Spells',
  spells: 'Spells',
  // Stash
  stash: 'Stash',
  // Stat
  st: 'Stat',
  sta: 'Stat',
  stat: 'Stat',
  status: 'Stat',
  // Stock
  sto: 'Stock',
  stoc: 'Stock',
  stock: 'Stock',
  // Suicide
  suicide: 'Suicide',
  // Sys
  sys: 'Sys',
  // Top
  to: 'Top',
  top: 'Top',
  // Track
  trac: 'Track',
  track: 'Track',
  // Train
  train: 'Train',
  // Uninvite
  uninvite: 'Uninvite',
  // Unstock
  uns: 'Unstock',
  unst: 'Unstock',
  unsto: 'Unstock',
  unstoc: 'Unstock',
  unstock: 'Unstock',
  // Use
  use: 'Use',
  // Verbose
  verb: 'Verbose',
  verbo: 'Verbose',
  verbos: 'Verbose',
  verbose: 'Verbose',
  // Wealth
  weal: 'Wealth',
  wealt: 'Wealth',
  wealth: 'Wealth',
  // Who
  wh: 'Who',
  who: 'Who',
  sc: 'Who',
  sca: 'Who',
  scan: 'Who',
  // Withdraw
  wit: 'Withdraw',
  with: 'Withdraw',
  withd: 'Withdraw',
  withdr: 'Withdraw',
  withdra: 'Withdraw',
  withdraw: 'Withdraw'
};

/**
 * What running a command can do to *where the character is standing*.
 *
 * Four answers rather than a boolean, because the two ways of being wrong here
 * are not symmetric and neither collapses into "moves" or "does not".
 */
export type MovementEffect =
  /** One of the ten directions. Walks an edge the realm data can name. */
  | 'moves'
  /** The realm's table names it, and it is not `Move`. Nothing can move. */
  | 'stays'
  /**
   * `sys go <map> <room>` and its siblings.
   *
   * These *do* move the character — and along nothing. There is no edge, no
   * direction and no way for a player without the command to repeat the trip,
   * so a record of one is a route this client would offer and could not walk.
   * Distinguished from `stays` because the character really is somewhere else
   * afterwards: an expectation queued before it can no longer be answered.
   */
  | 'teleports'
  /**
   * The table does not have this word.
   *
   * Which makes it the one thing a **text exit** can be. `go crimson portal`
   * and `enter manhole` are room data (`Message.cs` stores the three accepted
   * phrasings per exit), so no entry for them exists or could exist in
   * `Commands.cs`. It is also what a typo is — and a typo is said out loud in
   * the room rather than moving anybody, which is why a room arriving is the
   * evidence rather than the command being sent.
   */
  | 'unknown';

/** The ten directions, as the realm database spells them. */
const MOVE_WORDS = new Set(['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw', 'u', 'up', 'd', 'down']);

/**
 * The commands that open a fight, per the realm's own table.
 *
 * Command *names*, not spellings — `commandOf` resolves `aa` and `allout` to
 * `Bash` the way the server does, so a config or a player using any accepted
 * abbreviation still reads as an attack. Two consumers, one list: the tracker
 * binds `*Combat Engaged*` to the attack that provoked it, and auto-combat
 * reads a typed attack as the player taking the fight back after a `break`.
 */
export const ATTACK_COMMANDS: ReadonlySet<CommandName> = new Set([
  'Attack',
  'BackStab',
  'Bash',
  'Jumpkick',
  'Kick',
  'Punch',
  'Smash'
]);

/**
 * The command that re-reads the room without telling the room.
 *
 * A bare Enter. The server answers it with the room block for wherever the
 * character is standing and says nothing to anybody else — measured in
 * `logs/2026-08-30_20-57-36_main.mudcap.jsonl` (t=66056), where a line the
 * server kept no text of was answered with the name, the occupants, the exits
 * and the light.
 *
 * `l` prints the same block and *also* broadcasts `<name> is looking around
 * the room.` to everybody standing there — which this client already reads as
 * `player-looks`. Sent every few combat rounds and every idle tick that is a
 * standing announcement to the room that something is watching it, which is
 * spam in company and a tell in a PvP fight. So everything that re-reads a
 * room on the client's *own* behalf sends this; a look the player asks for is
 * still a look.
 *
 * Empty on purpose, and named so the places that send it can be found:
 * `SessionManager` writes `${command}\r\n`, so an empty command is the
 * terminator by itself.
 */
export const REREAD_ROOM = '';

/**
 * Words that look like commands, are not in the table above, and have been
 * sent by this client anyway.
 *
 * **`flee` is not a command and never has been.** It is not one of the 94
 * entries in `Commands.cs` under any of its 325 spellings, and the wire says
 * the same thing on a derivative realm: in
 * `logs/2026-09-02_21-04-28_festus.mudcap.jsonl` this client sent `flee`
 * **eleven** times between t=433715 and t=503450 and every one came back
 * `Your command had no effect.` — the server's answer to a word its dispatch
 * table does not have. The character was a mystic in `Graveyard, North-West
 * Corner` with five monsters on it, its escape had been configured and turned
 * on, and it was beaten from 70 HP to death without ever leaving the room. The
 * whole of the escape was one word that does nothing.
 *
 * How it got in is the part worth keeping. `docs/greatermud/combat.md` said
 * *"`flee` breaks combat and moves you"* in the middle of the hangup-penalty
 * analysis, and that document is a **reading** of the server's source rather
 * than a capture — the sentence was inferred from the penalty logic naming no
 * cost for running away, not observed. It then travelled: into `FleeConfig`,
 * into the strategy list, into the settings screen, into the options template
 * that tells the player what the strategy does, and into `HangUpConfig`'s
 * refusal, which recommended it by name. The one file in this repository that
 * holds the realm's actual vocabulary — this one — was never asked, though it
 * had been extracted whole a phase earlier for exactly this class of question.
 *
 * There is no `flee`-shaped command wearing another name, either. What breaks
 * combat and moves a character is a **direction**: `Move` is in the table, the
 * server prints the room's exits in every room block, and the character walks
 * out. The same capture proves the client had that answer four times over and
 * threw it away — it had itself sent the `n` that walked into 1/2620 a minute
 * earlier, that name is unique among 57,511 rooms so the room resolved, the
 * realm data gives 1/2620 `s → 1/2619` and `e → 1/2625`, and the server had
 * just printed `Obvious exits: south, east`. So the escape sends a
 * **direction**, always, and never a word invented for the purpose — see
 * `SessionManager.escape`.
 *
 * This list exists so the mistake cannot be made twice quietly.
 * `commands.test.ts` asserts every word in it is absent from `COMMAND_WORDS`
 * (the claim itself), and that nothing under `src/main/automation/` or
 * `src/main/session/` contains it as a sent command literal (the consequence).
 * A word leaves this list only when a capture shows the server answering it.
 */
export const NOT_COMMANDS: readonly string[] = ['flee'];

/**
 * The command a line of input reaches, or `null` for a word the table has no
 * entry for.
 *
 * Reads the first word only. Everything after it is an argument, and the
 * server's dispatch works the same way.
 */
export function commandOf(input: string): CommandName | null {
  const word = firstWord(input);
  if (word.length === 0) return null;
  return COMMAND_WORDS[word] ?? null;
}

/**
 * Whether this command can leave the character standing somewhere else.
 *
 * An empty line is a bare Enter, which reprints the room the character is
 * already in — `stays`, and stated rather than left to fall through to
 * `unknown`, because a bare Enter is the commonest thing a person sends and
 * treating it as a possible way through the realm is how the first false
 * record got written.
 */
export function movementEffect(input: string): MovementEffect {
  const word = firstWord(input);
  if (word.length === 0) return 'stays';
  if (MOVE_WORDS.has(word)) return 'moves';
  const command = COMMAND_WORDS[word];
  if (command === undefined) return 'unknown';
  if (command === 'Sys') return 'teleports';
  return command === 'Move' ? 'moves' : 'stays';
}

function firstWord(input: string): string {
  const text = input.trim().toLowerCase();
  const space = text.search(/\s/);
  return space < 0 ? text : text.slice(0, space);
}
