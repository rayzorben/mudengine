###
  @description This is for the User class. It should be used to track the state of the
  user, where they are in the realm, and all other additional details from the point
  of view of the user. This class should not be used for any automation, only updating the
  state.
###
net     = require 'net'
fs      = require 'fs'
util    = require 'util'
log     = require '../common/colorlog'
automation  = require '../automation/events'
extensions  = require '../common/extensions'
options   = require '../config/options'
persist   = require './persist'
Worn = require "../classes/worn.coffee"

{ search, next, removePath, route }  = require './path.coffee'

{ AnsiToHtml } = require './ansitoHtml.coffee'
{ TelnetSocket } = require 'telnet-stream'
{ EventEmitter } = require 'events'

MudBlock = require '../blocks/MudBlock.coffee'
require '../blocks/AllBlocks.coffee'

process    = 'user'

###
@description this is a mapping of the ansi codes to the unicode characters
###
codes = {
  128: 199, 129: 252, 130: 233, 131: 226, 132: 228, 133: 224, 134: 229, 135: 231
  136: 234, 137: 235, 138: 232, 139: 239, 140: 238, 141: 236, 142: 196, 143: 197
  144: 201, 145: 230, 146: 198, 147: 244, 148: 246, 149: 242, 150: 251, 151: 249
  152: 255, 153: 214, 154: 220, 155: 248, 156: 163, 157: 216, 158: 215, 159: 402
  160: 225, 161: 237, 162: 243, 163: 250, 164: 241, 165: 209, 166: 170, 167: 186
  168: 191, 169: 174, 170: 172, 171: 189, 172: 188, 173: 161, 174: 171, 175: 187
  176: 9617, 177: 9618, 178: 9619, 179: 9474, 180: 9508, 181: 193, 182: 194, 183: 192
  184: 169, 185: 9571, 186: 9553, 187: 9559, 188: 9565, 189: 162, 190: 165, 191: 9488
  192: 9492, 193: 9524, 194: 9516, 195: 9500, 196: 9472, 197: 9532, 198: 227, 199: 195
  200: 9562, 201: 9556, 202: 9577, 203: 9574, 204: 9568, 205: 9552, 206: 9580, 207: 164
  208: 240, 209: 208, 210: 202, 211: 203, 212: 200, 213: 305, 214: 205, 215: 206, 216: 207
  217: 9496, 218: 9484, 219: 9608, 220: 9604, 221: 166, 222: 204, 223: 9600, 224: 211
  225: 223, 226: 212, 227: 210, 228: 245, 229: 213, 230: 181, 231: 254, 232: 222, 233: 218
  234: 219, 235: 217, 236: 253, 237: 221, 238: 175, 239: 180, 240: 173, 241: 177, 242: 8215
  243: 190, 244: 182, 245: 167, 246: 247, 247: 184, 248: 176, 249: 168, 250: 183, 251: 185
  252: 179, 253: 178, 254: 9632, 255: 160
}

class User extends EventEmitter
  # privates
  _socket   = undefined
  _telnet   = undefined
  _pending  = ''
  _ansi     = new AnsiToHtml()
  _timeouts = {}

  Object.defineProperties @prototype,
    id:
      get: -> "#{@config.username}:#{@config.bbs.host}:#{@config.bbs.port}:#{@config.realm}"

  ###
  @description this is the constructor for the user class
  ###
  constructor: ->
    super()

    @options   = options
    @lastCommand = undefined
    @route   = []
    @idle    = []
    @inventory =
      items: []
      keys: []
      wealth: 0
    @health  = {}
    @profile   = {}
    @status  = {}
    @who     = []
    @keys    = ""
    @engine  =
      stats:
        damage: {}
        experience:
          total: 0
    @conversations =
      gossip: []
      local: []
      yell: []
      telepath: []
      gangpath: []
      broadcast: []
      auction: []

    automation this

  output: ->
    room:
      name:     @currentRoom?.name
      known:    @currentRoom?.known
      map:    @currentRoom?.map
      number:   @currentRoom?.room
      hiddenExits:   @currentRoom?.hiddenExits()
      players:  @currentRoom?.players
      mobs:     @currentRoom?.mobs.map (x) -> x?.Name
      exits:    @currentRoom?.exits
      items:    @currentRoom?.placed?.map (x) -> x?.name
      hiddenItems: @currentRoom?.hidden?.map (x) -> x?.Name
    health:
      hp:     @health.hp + '/' + @health.hpmax
      ma:     @health.ma ? @health.ma + '/' + @health.mamax
      state:    @health.state
    inventory:
      items:    @inventory?.items?.map (x) => quantity: x.qty, name: x.name, where: x.equipped
      keys:     @inventory?.keys?.map (x) => x.name
      wealth:   @inventory?.wealth
      encum:    @inventory?.encum + '/' + this.inventory.maxencum
    profile:  @profile
    status:   @status
    engine:   @engine
    who:    @who
    commands:   _commandList.map (command) -> command.replaceAll /\n/g, '\\n'
    queue:    _commandQueue.map (command) -> command.replaceAll /\n/g, '\\n'
    idle:     @idle
    conversations: @conversations

  ###
  @description prints out debug information
  ###
  debugPrint: ->
    console.log log.colors.reset + "==========================================="
    console.log util.inspect @output(), {depth: 99, colors:true}

  load: (file) ->
    @config = JSON.parse fs.readFileSync(file)
    @onConfigLoaded()

  printToViewport: (message) ->
    ansi = "\n#{log.colors.bg.blue}#{log.colors.bright+log.colors.fg.white}[#{message}]#{log.colors.reset}\n"
    ansi = _ansi.convert ansi
    @emit 'viewport-print', ansi

  ###
  COMMAND MANAGEMENT
  ###
  _maxCommands  = 25
  _commandList  = []
  _commandQueue   = []

  _directions = [ 'n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw', 'u', 'd', 'up', 'down' ]
  _lookDirections = [ 'north', 'south', 'east', 'west', 'northeast', 'northwest', 'southeast', 'southwest', ..._directions]

  command:  -> _commandQueue[0]
  commands: -> _commandList

  suppressMessages: ->
    return _commandQueue.length >= options.engine.maxQueuedCommands

  pushCommand: (command) ->
    _commandQueue.push command.toLowerCase().trimCommand()
    _commandList.push command.toLowerCase().trimCommand()
    _commandList.shift() if _commandList.length > _maxCommands

  ###
  @description returns a database friendly version of the command if it is a direction
  ###
  lastDirection: (command) -> command?.toUpperCase().replaceAll(/up/g, 'U').replaceAll(/down/g, 'D') if command?.toLowerCase() in _directions

  ###
  @description checks if the player was looking in a different direction
  ###
  wasLooking: (command) ->
    command?.word(0) in "look".getSubsets() and command?.word(1) in _lookDirections

  idleCommand: (command) -> @idle.push(command)

  ###
  STATE CHECKS
  ###
  isTyping: -> @keys.length > 0
  isSneaking: (sneaking = @engine.sneaking) -> @engine.sneaking = sneaking
  isAttacking: (attacking = @engine.attacking) -> @engine.attacking = attacking
  isFirstHit: (first = @engine.firstHit) -> @engine.firstHit = first
  inRealm: (status = @engine.inRealm) -> @engine.inRealm = status
  roomChanged: (changed = @engine.roomChanged) -> @engine.roomChanged = changed

  equip: (item) ->
    inventoryItem = @inventory.items.find (inv) -> inv.Name is item.Name
    inventoryItem?.equipped = Worn.nameOf item.Worn

  unEquip: (item) ->
    inventoryItem = @inventory.items.find (inv) -> inv.Name is item.Name
    inventoryItem.equipped = ''

  toggleAllOn: ->
    options.engine.allOn = not options.engine.allOn
    @sendline ''

  evalCommand: (command) ->
    try
      result = eval command
    catch
      result = error

    util.inspect result, {depth: 1, breakLength: Infinity}

  ###
  WHO
  ###
  removePlayer: (name) ->
    index = @who?.findIndex (item) -> item.first is name
    return unless index isnt -1
    player = @who?.splice(index, 1)[0]
    player.lastOnline = Date.formatNow()
    player.save()

  ###
  SOCKET/TELNET Event Handlers
  ###
  onConnect: ->
    log.toConsole 'debug', process, 'onConnect'
    _socket.setNoDelay(true);
    _telnet = new TelnetSocket _socket
    _telnet.on 'data', (buffer) =>
      @onData buffer
    _telnet.on 'close', =>
      log.toConsole 'debug', process, '_telnet closed'
      @onError()

    @emit 'connected', this

  reconnect: ->
    log.toConsole 'debug', process, 'reconnect'
    @disconnect() if _socket
    @connect()
    #callback = -> @connect
    #setTimeout callback, 3000

  onError: ->
    log.toConsole 'debug', process, 'onError'
    @inRealm false
    #TODO: fix
    @reconnect()

  onData: (buffer) ->
    return if buffer.length == 0

    log.toConsole 'silly', process, "\n===========================================================", true

    data = []
    buffer.forEach (byte) =>
      if byte >= 128 then data.push String.fromCharCode codes[byte] else data.push String.fromCharCode byte

    log.toConsole 'silly', 'buffer', 'data: ' + data.join('').replaceAll /\u001B/g, ''

    # if the telnet stream breaks on an ansi sequence we need to buffer it
    # not as big of a deal if it breaks on text although the ansi sequence may be lost
    # so maybe we need to check if it does break on text and buffer the last ansi
    # sequence
    #TODO: check if we need to support breaks on text
    data = _pending + data.join ''

    # reset _pending if it was a broken ansi sequence
    _pending = '' if match = _pending.match /(\x1b\[[0-9;]*?)$/

    # a large block was broken by an ansi sequence
    if match = data.match /(\x1b\[[0-9;]*?)$/
      data = data.replace /(\x1b\[[0-9;]*?)$/, ''
      _pending = match[1]

    # the banner and the username prompt are not separated by an ansiLine
    # we keep the 79D with the previous line versus the next so that we
    # can detect things like a long WhoList to see when it is complete
    # by waiting for the ending 79D
    log.toConsole 'silly', process, 'data: ' + data.replaceAll /\u001B/g, ''
    ansiLine = /(?<=\u001B\[79D)|(Welcome to the official \w+ server!)/

    data.split ansiLine
    .filter (line) -> line isnt undefined and line.length > 0
    .forEach (line) =>
      log.toConsole 'silly', process, 'line: ' + line.replaceAll /\u001B/g, ''
      @processLine line

  onTimeout: ->
    console.log 'onTimeout'
    @disconnect()
    @reconnect()

  ###
  SOCKET/TELNET Operations
  ###
  connect: ->
    _socket = new net.createConnection @config.bbs.port, @config.bbs.host
    _socket.on 'connect', =>
      log.toConsole 'debug', process, "socket connected #{@config.bbs.host}:#{@config.bbs.port}"
      clearTimeout(timer)
      @onConnect()
    _socket.on 'error', =>
      log.toConsole 'error', process, "socket error"
      clearTimeout(timer)
      @onError()

    callback = => @onTimeout()
    timer = setTimeout callback, 3000

  disconnect: -> _socket.destroy()

  ###
  SOCKET/TELNET write operations and helpers
  ###
  sendline: (line) -> @send line + "\r\n"
  userHitEnter: -> @onUserCommand result if result = @send "\r\n"

  keyPress: (message) ->
    # CTRL+V functionality if user is sending a conversation
    pattern = /^(-|\.|"|gos\s|bg\s|gb\s|broadg\s|br\s|\/\w+\s)/
    match = @keys.match pattern
    prefix = if match then match[0] else ''

    message.split(/(?<=[\n])/).forEach (part, index, arr) =>
      if index == 0
        @send part
      else
        @send prefix + part
        @send() if index is arr.length - 1

    return true

  send: (data) ->
    result = @keys += data

    # clear anything pending out and prevent sending if the command queue is full
    if @keys.endsWith "\r\n" and @suppressMessages()
      @send "\b".repeat(@keys.length - 2)
      return @keys = ''

    _telnet.write data

    if @keys.endsWith "\r\n"
      @onCommand @keys
      @keys = ''

    return result

  backspace: ->
    @keys = @keys.slice 0, -1
    _telnet.write "\b"
    return true

  processLine: (line) ->
    block = MudBlock.from this, line
    process = block.constructor.name

    log.toConsole 'silly', process, '[' + log.colors.fg.yellow + block.constructor.name + log.colors.reset + ']'
    #console.log '[' + log.colors.fg.yellow + block.constructor.name + log.colors.reset + ']'
    log.toStdout 'silly', process, line

    #TODO: should we clear if it was removed????????
    @lastCommand = _commandQueue.nextMatch block.commands if block.commands
    log.toConsole 'silly', process, "BLOCK: #{block.constructor.name}"
    log.toConsole 'silly', process, "COMMAND: [#{@lastCommand?.replaceAll(/\n/g, '\\n')}]"

    if not block.process @lastCommand
      log.toConsole 'silly', process, 'FULL BLOCK NOT RECEIVED, PENDING'
      return _pending = line

    _commandQueue.filterUntilMatch block.commands if block.commands

    # if what is pending is not a broken ansi, then reset pending as we've processsed a block
    _pending = '' if not match = _pending.match /(\x1b\[[0-9;]*?)$/

    @onMudBlock block

    @emit 'block', block.json()
    @sendline block.response() if block.response()
    process = 'user'

  ###
  NAVIGATION
  ###
  goto: (map, room) ->
    @printRouteTo "#{map},#{room}"
    console.log "******** Going to #{map},#{room}"
    @sendline 'pr'
    @sendline ''
    setTimeout =>
      @route = search this, [@currentRoom.map, @currentRoom.room], [map, room], null
    , 100

  stopRoute: ->
    console.log "Stopping route..." if @route.length >= 1
    @route = []

  printRouteTo: (location) ->
    [map, room] = location.split(/\D+/).filter(Boolean)
    directions = search this, [@currentRoom.map, @currentRoom.room], [map, room], null
    @printToViewport r for r in route(directions)

  doSneak: ->
    if not @isSneaking() and @status.health > 0 and @currentRoom?.mobs?.length is 0
      return @sendline 'sn'

    return false

  doStep: ->
    @currentDirection = next @route if @route and @route.length isnt 0
    return false unless @currentDirection
    return @processStep @currentDirection

  processStep: (step) ->
    return @sendline step.command if step.command
    return @sendline "sea #{step.direction.toLowerCase()}" if step.search
    return @sendline step.direction.toLowerCase() if step.direction


  ###
  EVENTS
  ###

  # decorator for adding a post-event event to every event
  @event: (name, target) -> ->
    log.toConsole 'silly', 'userEvent', 'event: ' + name
    target.apply this, arguments
    @emit name, ...arguments

  onConfigLoaded: @event "config-loaded", -> @emit 'user-config', @config

  onMudBlock: @event "mud-block", (block) -> return

  onCommand: (command) -> @pushCommand command if command

  onUserCommand: @event "user-command", (command) ->
    @route = [] if @lastDirection command

  onPlayerAction: @event "player-action", (line, player, action) ->
    _commandQueue.shift()

  onGameEnter: @event "game-enter", ->
    _commandQueue = []
    _commandList = []

    @isSneaking no

    @idleCommand 'sc'
    @idleCommand 'pro'
    @idleCommand 'l'
    @idleCommand 'st'
    @idleCommand 'i'
    @idleCommand 'exp'

  onIdle: @event "idle", ->
    @sendline @idle.shift() if options.engine.allOn and @idle.length > 0 and not @isTyping()

  onStep: @event "step", ->
    return if @isTyping()
    #TODO: process attacks, grab items, etc, then move, then do idle if no commands
    return if @doSneak()
    return if @doStep()

    @onIdle()

  onCombatOn:   @event "combat-on", -> return
  onCombatOff:  @event "combat-off", -> return
  onCombatStatus: @event "combat-status", (status) ->
    @isAttacking status

  onMobAttacking: @event "mob-attack", (mob) ->
    # TODO: check list of mobs and make sure it is in the list
    # TODO: also a player attacking
    @sendline "a #{ mob }" unless @isAttacking()

  onCombatRound: ->
    #TODO: reset this to false on the off round
    # the idea here is that the first hit will reset the start of the combat
    # round so that we can determine when the off round will occur
    @isFirstHit true unless @isFirstHit()

  onStatusLine: @event "status-line", (event, hp, ma, type, state) ->
    @health.hp    = hp
    @health.ma    = ma
    @health.type  = type
    @health.state   = state

    return if _timeouts['onStep']
    _timeouts['onStep'] = setTimeout =>
      delete _timeouts['onStep']
    , 100
    @onStep()

  onPlayerEnter: @event "player-enter", (player) ->
    @idleCommand "\r\n" # check the room at next opportunity
    @idleCommand 'sc'

  onPlayerLeft: @event "player-left", (player) ->
    @removePlayer player

  onPlayerExit: @event "player-exit", (player) ->
    @onPlayerLeft player

  onPlayerSeen: @event "player-seen", (player) ->
    who = @who.find (item) -> item.first is player
    console.log "player seen: #{player}"
    who?.lastSeen = Date.formatNow()
    who?.save()

  onPlayerDisconnect: @event "player-disconnect", (player) ->
    @onPlayerLeft player

  onMessageCommand: @event 'message-command', (source, command, args) ->
    source.reply "You sent me a command #{command} : #{args}"

  onGossip: @event 'conversation-gossip', (convo, source, message) ->
    @conversations.gossip.push "#{source}: #{message}"

  onLocal: @event 'conversation-local', (convo, source, message) ->
    @conversations.local.push "#{source}: #{message}"

  onYell: @event 'conversation-yell', (convo, source, message) -> return
  onYouYell: @event 'conversation-you-yell', (convo, message) -> return
  onTelepath: @event 'conversation-telepath', (convo, source, message) -> return
  onGangpath: @event 'conversation-gangpath', (convo, source, message) -> return
  onBroadcast: @event 'conversation-broadcast', (convo, source, message) ->
    @conversations.broadcast.push "#{source}: #{message}"

  onHiddenItems: @event 'items-hidden', (items) ->
    items.forEach (item) => @onItemOnGround item
  onVisibleItems: @event 'items-visible', (items) ->
    items.forEach (item) => @onItemOnGround item
  onItemOnGround: @event 'item-on-ground', (item) -> return

  onCommandFailed: @event 'command-failed', (failure, command) ->
    switch failure
      when "direction-failed" then return
      when "command-ignored" then return
      when "bash-failed" then _commandQueue.shift()
      when "command-no-effect" then _commandQueue.shift()
      when "equip-failed" then return
      when "search-failed" then return

  onRoom: @event 'room', (room) -> return
  onNewRoom: @event 'new-room', (room) ->
    @roomChanged true
    @isSneaking false

    @currentDirection = null
    @route.shift()

    persist.upsert { user: @id, type: "location" }, { map: room.map, room: room.room }

  onExitFound: @event 'exit-found', (direction) ->
    @currentDirection.search = false
    # clear the search flag for the current direction so that the next step moves
    # should we sleep if search failed - onCommandFailed "search-failed"

  onStatus: @event 'status', (status) -> return
  onWho: @event 'who', (player) ->
    @status.gang = player.gang if player.isSelf this

  onCombatHit: @event 'combat-hit', (source, target, damage) ->
    if source is "You"
      @engine.stats.damage.total ?= 0
      @engine.stats.damage.total += damage

  onMobHit: @event 'mob-hit', (source, damage) -> @onMobAttacking source
  onMobMiss: @event 'mob-miss', (source, damage) -> @onMobAttacking source

  onSneak: @event 'sneak', (status) -> @isSneaking status


  onUserExperience: @event 'experience', (stats) -> return
  onUserGainExperience: @event 'experience-gained', (exp) ->
    @engine.stats.experience.total ?= 0
    @engine.stats.experience.total += exp

  onEquip: @event 'user-equip', (item) -> @equip item
  onUnequip: @event 'user-unequip', (item) -> @unEquip item
  onItemBuy: @event 'user-item-buy', (item, price) ->
    @inventory.wealth -= price
    result = @inventory.items?.find (inv) -> inv.Name is item.Name
    if result
      result.quantity += item.qty
    else
      @inventory.items.push item

  onUserProfile: @event 'profile', (map, room) -> return

  ###
  MAIN WINDOW COMMUNICATION
  ###
  notify: (message)     -> @emit 'notify-ok', message
  notifyInfo: (message)   -> @emit 'notify-info', message
  notifyWarn: (message)   -> @emit 'notify-warn', message
  notifyAlert: (message)  -> @emit 'notify-alert', message

module.exports = User