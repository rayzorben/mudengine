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
    @data     = {}

  reRead: ->
    @data = data.rooms.byId @map, @room
    #@merge data.rooms.byId @map, @room
    @fixMobs()

  # ok lets type this out
  # when you first enter you get a room such as Docks
  # its not resolved but newRoom is true
  # however map/room is blank and so is data

  process: (command) ->
    #TODO: when a command such as "go man" occurs we lose the room
    #console.log "LOOKING" if @user.wasLooking command
    return super.process() if @user.wasLooking command
    #console.log "COMMAND WAS [#{command?.replaceAll /\n/g, '\\n'}]"

    # parse everything first name, exits, here, items
    room    = @getRoom @line.split(/\r\n/).find (line) -> line isnt undefined # get the first room matching this name, can return 0 or n
    @name   = room.Name # set the name from the database record

    result  = /^Obvious exits: (?<exits>[\w, ]+)/ms.exec @line # get the explicit list of exits
    @exits  = result.groups.exits.split /,\s/g # set an array of exits for this room

    @associatedDirection = @user.lastDirection command
    #TODO: we can use the lair mobs to narrow it down, for example
    #Intersection of Guild St. & River St. resolves to just a single one with guardsman in it
    #resolved = @resolveRoom @name # resolves by name/exits or direction from previous room

    #console.log "RESOLVED #{resolved?.Name}"

    # the room name is set so we dont have to pass it as a parm
    resolved = @resolveRoom()

    # none of this should rely on the map/room being set or any data in the database being read
    @getAlsoHere() # gets a list from Also here and just populates here[]
    @getRoomItems() # parses items into database equiv into @placed array

    @newRoom =
      @user.currentRoom?.data?.Name isnt @name or # name changes
      @associatedDirection or # user entered a direction such as 'n'
      (resolved and (@user.currentRoom?.data?['Map Number'] isnt resolved?['Map Number'])) or # map changes
      (resolved and (@user.currentRoom?.data?['Room Number'] isnt resolved?['Room Number'])) # room changes
      
    @data = if not @newRoom then @user.currentRoom?.data else resolved
    #@data = @user.currentRoom.data if not @newRoom else @user
    
    @map = @data?['Map Number']
    @room = @data?['Room Number']
    @fixMobs()

    # we have to check if this is a newRoom for the event before we do this
    # so right now there is no guarantee that map and room have been set
    @user.currentRoom = this
    
    # @newRoom =
    #   @user.currentRoom?.name isnt @name or # name changes
    #   @associatedDirection or
    #   (resolved and @user.currentRoom?.map isnt resolved?['Map Number']) or # map changes
    #   (resolved and @user.currentRoom?.room isnt resolved?['Room Number']) # room changes
    # #console.log "NEWROOM: #{@newRoom}"
    # # set the currentRoom to this as we know we will have some details regardless
    # if not @user.currentRoom
    #   #console.log "USER HAS NO CURRENT ROOM, SETTING IT"
    #   @user.currentRoom = this
    # # now merge the currentRoom into this room if it hasn't changed
    # if not @newRoom
    #   #console.log "NOT A NEW ROOM, MERGING CURRENT ROOM INTO THIS"
    #   @merge @user.currentRoom if not @newRoom

    # if @newRoom and resolved
    #   #console.log "NEWROOM MERGING RESOLVED INTO IT"
    #   # finally take any new info and merge it in if it is new
    #   @merge resolved if @newRoom and resolved

    #TODO: morning. fixmobs should be as simple as whether or not the mob is in the database
    # if it is its a mob if it is not its a player then we can resolve mobs individually
    # SELECT * FROM Monsters WHERE Name IN ('guardsman', 'shade')
    #@map = @['Map Number']
    #@room = @['Room Number']

    #@fixMobs()

    #@user.stopRoute() if not @map
    #console.log "MAP/ROOM #{@map} #{@room}"

    @properties['data-map'] = @map
    @properties['data-room'] = @room
    @properties['data-shop'] = ShopTypes.nameOf @shop?.ShopType if @shop?.ShopType > 0

    #@user.currentRoom = this

    @user.onNewRoom this if @newRoom
    @user.onRoom

    return super.process()

  resolveRoom: (room) ->
    # the name only matched one record in the database
    rooms = data.rooms.byName(@name)
    return rooms.shift() if rooms.length is 1

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

    next = @user.currentRoom?.data?[direction]

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

    log.toConsole 'silly', 'mobs', "Also here: #{result.groups.who}"
    result.groups.who.split /, /
    .forEach (who) =>
      @here.push who.replace /\r\n/, ' '

  mobInLair: (mobs) ->
    log.toConsole 'silly', 'mobs', "no lair for #{mobs}" unless @Lair
    return unless @Lair # database flag marking this as a lair
    log.toConsole 'silly', 'mobs', "mobInLair being checked for #{mobs}"

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

    log.toConsole 'silly', 'mobs', "mobs: #{@mobs}"
    log.toConsole 'silly', 'mobs', "players: #{@players}"

    whoNeeded = false
    @players.forEach (player, index) =>
      player = player.replace /\*$/, ''
      log.toConsole 'silly', 'mobs', "finding player #{player}"
      who = @user.who?.find (x) -> x.first == player
      if who
        @players[index] = who
      else
        Player.lookup(@user.id).then (doc) => @players[index] = doc if doc
      @user.onPlayerSeen player
      whoNeeded = true unless who

    @user.idleCommand 'sc' if whoNeeded

    @mobs.forEach (mob, index) =>
      mob = mob.replaceAll mobPrefixes, ''
      match = mobs.filter (x) -> x.Name == mob
      log.toConsole 'silly', 'mobs', "searching for #{mob}"
      log.toConsole 'silly', 'mobs', "matched #{match.length} mobs in database"
      return (=>
        log.toConsole 'silly', 'mobs', "matched only 1 #{mob}"
        @mobs[index] = match.shift()
      )() if match.length is 1

      log.toConsole 'silly', 'mobs', "no direct match found using room #{@map}/#{@room}"
      summoned = data.monsters.bySummon mob, @map, @room if @map and @room

      return (=>
        log.toConsole 'silly', 'mobs', "summoned mob #{summoned[0]}"
        @mobs[index] = summoned.shift()
      )() if summoned?.length is 1

      log.toConsole 'silly', 'mobs', "checking lair map #{@map} room #{@room}"

      lairmobs = @mobInLair match.map (x) -> x.Number
      found = mobs.find (x) -> (x.Number == lairmobs[0]) if lairmobs?.length >= 1

      return (=>
        log.toConsole 'silly', 'mobs', "lair mob #{found}"
        @mobs[index] = found
      )() if found
      
      summoned = data.monsters.bySummonMap mob, @map if @map

      return (=>
        log.toConsole 'silly', 'mobs', "mob by map only #{summoned[0]}"
        @mobs[index] = summoned.shift()
      )() if summoned?.length is 1
      
      log.toConsole 'debug', 'mobs', "not found mob #{mob}"
      @mobs[index] = match.shift()


  hiddenExits: ->
    results = {}
    for key in ['U', 'D', 'N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW']
      if @data[key]?.includes 'Text:'
        results[key] = @data[key].match(/Text: (.+)\)/)?[1]
    results