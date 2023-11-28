extensions  = require '../common/extensions'
meta    = require '../engine/meta.coffee'
data    = require '../engine/data.coffee'
log     = require '../common/colorlog'
ShopTypes = require '../classes/shopTypes.coffee'
MudBlock = require './MudBlock.coffee'
RoomBase = require './RoomBase.coffee'
Items = require '../classes/items.coffee'
Player = require '../classes/player.coffee'

@classes  = meta 'classes', yes # classes to add to the html element
@match    = meta 'match' # regex to match this block

@classes ['room'],
@match /^Obvious exits: [\w, ]+/ms,
class Room extends RoomBase
  @child = MudBlock.derived.add this

  constructor: (user, line) ->
    super user, line

    @associatedDirection = null
    @newRoom  = false
    @exits    = []
    @here     = []
    @mobs     = []
    @players  = []
    @placed   = []

  reRead: ->
    @merge data.rooms.byId @map, @room
    @fixMobs()

  process: (command) ->
    #TODO: when a command such as "go man" occurs we lose the room
    #console.log "LOOKING" if @user.wasLooking command
    return super.process() if @user.wasLooking command
    #console.log "COMMAND WAS [#{command?.replaceAll /\n/g, '\\n'}]"

    # parse everything first name, exits, here, items
    room  = @getRoom @line.split(/\r\n/).find (line) -> line isnt undefined
    @name   = room.Name

    result  = /^Obvious exits: (?<exits>[\w, ]+)/ms.exec @line
    @exits  = result.groups.exits.split /,\s/g

    @associatedDirection = @user.lastDirection command
    #TODO: we can use the lair mobs to narrow it down, for example
    #Intersection of Guild St. & River St. resolves to just a single one with guardsman in it
    resolved = @resolveRoom @name # resolves by name/exits or direction from previous room

    #console.log "RESOLVED #{resolved?.Name}"

    @newRoom =
      @user.currentRoom?.name isnt @name or # name changes
      @associatedDirection or
      (resolved and @user.currentRoom?.map isnt resolved?['Map Number']) or # map changes
      (resolved and @user.currentRoom?.room isnt resolved?['Room Number']) # room changes
    #console.log "NEWROOM: #{@newRoom}"
    # set the currentRoom to this as we know we will have some details regardless
    if not @user.currentRoom
      #console.log "USER HAS NO CURRENT ROOM, SETTING IT"
      @user.currentRoom = this
    # now merge the currentRoom into this room if it hasn't changed
    if not @newRoom
      #console.log "NOT A NEW ROOM, MERGING CURRENT ROOM INTO THIS"
      @merge @user.currentRoom if not @newRoom

    if @newRoom and resolved
      #console.log "NEWROOM MERGING RESOLVED INTO IT"
      # finally take any new info and merge it in if it is new
      @merge resolved if @newRoom and resolved

    @getAlsoHere()
    @getRoomItems()
    #TODO: morning. fixmobs should be as simple as whether or not the mob is in the database
    # if it is its a mob if it is not its a player then we can resolve mobs individually
    # SELECT * FROM Monsters WHERE Name IN ('guardsman', 'shade')
    @fixMobs()

    @map = @['Map Number']
    @room = @['Room Number']
    @user.stopRoute() if not @map
    #console.log "MAP/ROOM #{@map} #{@room}"

    @properties['data-map'] = @map
    @properties['data-room'] = @room
    @properties['data-shop'] = ShopTypes.nameOf @shop?.ShopType if @shop?.ShopType > 0

    @user.currentRoom = this

    @user.onNewRoom this if @newRoom
    @user.onRoom

    return super.process()

  resolveRoom: (room) ->
    rooms = @getRoomFromListOfExits @exits

    return (->
      #console.log "ONLY ONE ROOM MATCHED"
      rooms.shift()
    )() if rooms.length is 1
    return (->
      #console.log "NO CURRENT ROOM"
    )() unless @user.currentRoom

    # get a map and room from the direction relative to the current room
    direction = @associatedDirection
    return (->
      #console.log "NO DIRECTION"
     )() unless direction

    next = @user.currentRoom[direction]

    return unless next

    result    = /(?<map>\d+)\/(?<room>\d+)(?: \((?<note>.*)\))?/.exec next
    data.rooms.byId result.groups.map, result.groups.room if result

  getRoom: (name) -> data.rooms.byName(name).find (x) -> x isnt undefined

  getRoomFromListOfExits: (exits) ->
    n = s = e = w = ne = nw = se = sw = u = d = 1

    current = []
    exits.forEach (exit) ->
      current.push exit
      switch exit.replace /(closed|open) (gate|door) /g, ''
        when 'north' then n = 0
        when 'south' then s = 0
        when 'east' then e = 0
        when 'west' then w = 0
        when 'northeast' then ne = 0
        when 'northwest' then nw = 0
        when 'southeast' then se = 0
        when 'southwest' then sw = 0
        when 'up' then u = 0
        when 'down' then d = 0

    data.rooms.byExits @name, n, s, e, w, nw, ne, sw, se, u, d

  getRoomItems: ->
    log.toConsole 'silly', 'blockRoom', "getRoomItems #{@line}"
    @placed = []

    return unless result = /^You notice (?<items>.*?) here\./sm.exec @line

    log.toConsole 'silly', 'blockRoom', "items: #{result.groups.items}"
    @placed = Items.from result.groups.items.replaceAll /\r\n/g, ' '
    @user.onVisibleItems @placed

  #TODO: if mobs wrap into the next line it doesn't identify them
  #Sheriff Lionheart, fierce
  #Templar
  getAlsoHere: ->
    @here = []
    return unless result = /^Also here: (?<who>[*\w,\r\n ]+)\.$/gm.exec @line

    log.toConsole 'sillly', 'mobs', "Also here: #{result.groups.who}"
    result.groups.who.split /, /
    .forEach (who) =>
      @here.push who.replace /\r\n/, ' '

  mobInLair: (mobs) ->
    return unless @Lair # database flag marking this as a lair

    # this is a list of mobs that are supposed to be in this lair, by number
    return unless result = /\(Max \d+\): (?<mobs>[\d,]+)$/.exec @Lair

    lairmobs = result.groups.mobs.split /,/
      .filter (x) -> x isnt undefined
      .map (x) -> parseInt(x)

    return mobs.filter (x) => lairmobs.includes(x)

  fixMobs: ->
    mobPrefixes = /(short|tall|nasty|angry|large|fat|thin|big|small|fierce|content|happy) /g
    mobs = data.monsters.byList @here.map (name) -> name.replaceAll mobPrefixes, ''

    @mobs = @here.filter (name) -> mobs.some (mob) -> mob.Name == name.replaceAll mobPrefixes, ''
    @players = @here.filter (name) -> not (mobs.some (mob) -> mob.Name == name.replaceAll mobPrefixes, '')

    log.toConsole 'sillly', 'mobs', "mobs: #{@mobs}"
    log.toConsole 'sillly', 'mobs', "players: #{@players}"

    whoNeeded = false
    @players.forEach (player, index) =>
      who = @user.who?.find (x) -> x.first == player
      if who
        @players[index] = who
      else
        Player.lookup(@user.id).then (doc) => @players[index] = doc if doc
      @user.onPlayerSeen player
      whoNeeded = true unless who

    @user.idleCommand 'sc' if whoNeeded

    @mobs.forEach (mob, index) =>
      match = mobs.filter (x) -> x.Name == mob.replaceAll mobPrefixes, ''
      return (=>
        log.toConsole 'sillly', 'mobs', "matched only 1 #{match[0]}"
        @mobs[index] = match.shift()
      )() if match.length is 1

      summoned = data.monsters.bySummon mob, @map, @room if @map and @room

      return (=>
        log.toConsole 'sillly', 'mobs', "summoned mob #{summoned[0]}"
        @mobs[index] = summoned.shift()
      )() if summoned?.length is 1

      lairmobs = @mobInLair match.map (x) -> x.Number
      found = mobs.find (x) -> (x.Number == lairmobs[0]) if lairmobs?.length >= 1

      return (=>
        log.toConsole 'sillly', 'mobs', "lair mob #{found}"
        @mobs[index] = found
      )() if found

      log.toConsole 'sillly', 'mobs', "not found mob #{mob}"


  hiddenExits: ->
    results = {}
    for key in ['U', 'D', 'N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW']
      if @[key]?.includes 'Text:'
        results[key] = @[key].match(/Text: (.+)\)/)?[1]
    results