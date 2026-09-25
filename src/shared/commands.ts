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
 * The commands that leave this character standing in plain sight.
 *
 * `BreakStealth()` has thirty callers in the server and **not one of them
 * prints a word about it**. The only statement of stealth on the wire is
 * `Sneaking...`, and that arrives on the next successful move — after the step
 * it describes has been taken. So a break has to be read off the command that
 * causes it, in the one place every outbound command passes through
 * (`CharacterTracker.observeCommand`).
 *
 * Command *names*, so every spelling comes free through `commandOf`. Each
 * entry is a site in the server, not a guess:
 *
 * - the attack verbs — `AttackCommand.cs:408`, beside `*Combat Engaged*`. The
 *   one case it exempts is a backstab *from* stealth, and
 *   `BackstabCombatRound.DoPostRound` clears `Sneaking` when that round lands,
 *   which is the same command's output.
 * - `Cast` and `Use` — `Player.InitiateSpell:5752` clears it before the mana
 *   check, so a cast that fails the roll has still broken it, and an item's
 *   spell reaches the same call (`Spell.cs:2005`).
 * - `Rest` (`RestCommand.cs:33`), `Meditate` (`MeditateCommand.cs:37`),
 *   `Break` (`BreakCommand.cs:28`), `Share` (`ShareCommand.cs:68`),
 *   `Equip` (`EquipCommand.cs:138,165`), `Buy` (`BuyCommand.cs:189`),
 *   `Give` (`GiveCommand.cs:88,237`).
 * - `Search` — bare only; see `breaksStealth`.
 *
 * **Not here, deliberately.** The barrier work (`Open`, `Close`, `Lock`,
 * `Pick`) breaks stealth too and is read from `door-changed` instead, because
 * that sentence knows the one branch that does not (`The door was already
 * open.`). `Light`, `Remove`, `Get` and `Drop` call nothing, and a potion's
 * spell is applied directly rather than cast (`DrinkCommand.cs:77`), so
 * `Drink` is safe as well.
 *
 * The pessimistic direction is cheap and the optimistic one is not: a command
 * listed here that the server refuses costs one `sn`, and a missing one walks
 * a character into a lair believing it is hidden.
 */
export const STEALTH_BREAKING: ReadonlySet<CommandName> = new Set<CommandName>([
  ...ATTACK_COMMANDS,
  'Buy',
  'Break',
  'Cast',
  'Equip',
  'Give',
  'Meditate',
  'Rest',
  'Search',
  'Share',
  'Use'
]);

/**
 * The five characters that make a line a comm rather than a command, and the
 * two of them the room can hear.
 *
 * `CommManager.CheckCommandForComm` runs before the command table: `.` is talk
 * and `"` is a shout, and those two alone call `BreakStealth()` (`:243`,
 * `:259`) — the room heard it. `/` telepath, `>` tell and `-`/`'` broadcast go
 * to somebody elsewhere and say nothing here, so they leave stealth alone.
 */
const HEARD_IN_THE_ROOM = new Set(['.', '"']);
const COMM_PREFIXES = new Set(['.', '"', '/', '>', '-', "'"]);

/**
 * Whether sending this puts the character back in plain sight.
 *
 * Two rules beyond the list, and the second is the one that is easy to miss.
 *
 * `search <direction>` is exempt: `SearchCommand.cs` sends a bare search to
 * `Player.TrySearch`, which breaks stealth beside `Your search revealed
 * nothing.`, and a directional one to the exit's own `SearchExit`, which does
 * not. The walker's answer to a hidden edge is the directional form, so this
 * is the difference between a walk that sneaks and one that pays an `sn` at
 * every hidden exit.
 *
 * **A word the table has no entry for is not silence.** It is said out loud in
 * the room (`Player.cs:1883`) or performed as an emote
 * (`ActionFigure.PerformAction:281`), and both break stealth; the third thing
 * it can be is a text exit (`go manhole`), which is a move, and a move that
 * kept stealth prints `Sneaking...` — so the receipt corrects this the moment
 * it lands. The `SlowTalk` branch answers `Your command had no effect.` and
 * breaks nothing, and which branch a character takes is not visible from here:
 * that one costs an `sn` and is the direction to be wrong in.
 */
export function breaksStealth(input: string): boolean {
  const text = input.trim();
  if (text.length === 0) return false;
  const first = text.slice(0, 1);
  if (COMM_PREFIXES.has(first)) return HEARD_IN_THE_ROOM.has(first);
  const command = commandOf(text);
  if (command === null) return true;
  if (command === 'Search') return text.search(/\s/) < 0;
  return STEALTH_BREAKING.has(command);
}

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
 * The claim one `REREAD_ROOM` filed on the room its answer reprints, asked
 * after by whoever sent it: owed until the tracker takes it off the queue,
 * with the room block that answered it or with nothing (a refusal behind it,
 * the write-off, a locate, a death). The tracker says which claim a room
 * answered, so a sender waiting on its own reprint reads that rather than
 * counting rooms: a reprint already on the wire answers the claim ahead of
 * it (todo 767).
 */
export interface RereadClaim {
  owed(): boolean;
}

/** Where the latest bare Enter's claim is read: null when it filed none, outside the realm. */
export interface RereadClaims {
  readonly lastReread: RereadClaim | null;
}

/**
 * Commands in the table above that the **MajorMUD lineage does not have**.
 *
 * Two realms ship in this client and they are not the same server. Sending a
 * word a realm has no entry for costs a command out of the budget walking and
 * fighting spend from, and on a clock it costs one per ask for the evening.
 *
 * **Command names, and every spelling comes free** through `commandOf`, which
 * is what the server does.
 *
 * ## Measured, on one authorised session
 *
 * `bbs.bearfather.net`, majorMUD v1.11p-WG3NT, 2026-09-05: forty read-only
 * words from the table above, one per second, and what came back. `Your
 * command had no effect.` is that lineage's answer to a word it has no entry
 * for — see `src/shared/realm.ts` for why that sentence and not GreaterMUD's
 * spoken refusal.
 *
 * **Two positive controls make the reading mean something**, because the same
 * sentence could have been what a present command answers when its arguments
 * are missing or the room is wrong. It is not:
 *
 * - `stock` → `Syntax: STOCK {item} {price} {currency}` — a present command
 *   with no arguments gets *syntax help*.
 * - `list` → `You cannot LIST if you are not in a shop!` — a present command
 *   in the wrong room gets *the reason*.
 *
 * So `Your command had no effect.` is absence, and these seven are absent:
 * `Room` (`rm`), `Abilities` (`ab`), `Deaths`, `Roll`, `NParty`, `Recover` and
 * `Appraise`.
 *
 * ## `Profile` is **not** one of them, and that correction cost nothing but
 * asking
 *
 * `docs/game-behaviour.md` said *"MajorMUD has neither `rm` nor `pro`"* and
 * this list said so too, for one day. Half of it was wrong: `pro` answers
 * there in full — `Display Mode`, `Statusline`, `Allow Telepaths`, sixteen
 * more lines of the character's own preferences. What it does not carry is
 * `Location:`, which is the *only* part GreaterMUD's `pro` is read for.
 *
 * The claim came from a reading rather than a capture, and the shape of the
 * error is the usual one: *this realm has no locate command* generalised into
 * *this realm has no such word*. `familyToldBy` was right anyway and is now
 * better evidenced — both lineages answer `pro`, and only GreaterMUD's answer
 * carries coordinates, so the tell tests the **groups** and not the type.
 *
 * ## What the client actually sends is the part that mattered
 *
 * Of the commands this client puts on the wire by itself — `rm`, `st`, `i`,
 * `exp`, `sc`, `gb`, `bank`, `spells`/`pow`, `party`, `rest`, `med`, `sea`,
 * `sn`, `l`, `list` — **only `rm` is missing**. Everything else answered. So
 * the cost of the whole question was one wasted command per connection, and
 * the client already retired that one.
 *
 * A word joins this list when something says so. The client does not need the
 * whole difference to be safe, because **the wire teaches it the rest**:
 * `SessionManager` retires any word this file's table names that the realm
 * refuses, for the connection. This list is what it knows before the first
 * refusal, which is the only place a list beats learning.
 */
export const GREATERMUD_ONLY: ReadonlySet<CommandName> = new Set([
  'Room',
  'Abilities',
  'Deaths',
  'Roll',
  'NParty',
  'Recover',
  'Appraise'
]);

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
 * `Travel.escape`.
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
 * Whether this command hands the terminal over to the stat-assignment screen.
 *
 * `train stats` at a trainer is the one command in the table whose answer is
 * not a sentence and not a prompt: `TrainCommand.cs:72` calls `Player.Exits()`
 * and drops the character into `PlayerWaitState.TrainStats`, from which the
 * next thing on the wire is a telnet field form. See `user-stats-screen`.
 *
 * **The argument is matched exactly as the server matches it.** `trainArgs ==
 * "stats"` is a case-sensitive comparison against a trimmed argument
 * (`Player.cs:1912` keeps the command's case; its `.ToLower()` is commented
 * out), so `train Stats` is answered with `Your command had no effect.` and a
 * prompt. Mirroring that rather than being tolerant of it keeps this a reading
 * of the server rather than a guess about it — and the screen's own block is
 * the second, independent arm for a realm whose rule turns out to differ.
 */
export function opensStatScreen(input: string): boolean {
  if (commandOf(input) !== 'Train') return false;
  const text = input.trim();
  const space = text.search(/\s/);
  return space >= 0 && text.slice(space + 1).trim() === 'stats';
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
