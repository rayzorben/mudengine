extensions  = require '../common/extensions'
meta    = require '../engine/meta.coffee'
MudBlock = require './MudBlock.coffee'

@match    = meta 'match' # regex to match this block
@commands   = meta 'commands' # allowable commands for this block

@match /^Recent Deaths:/m,
@commands [..."profile".getSubsets(1)],
class UserProfile extends MudBlock
  @child = MudBlock.derived.add this

  process: ->
    return unless result = /^Location:\s+(?<map>\d{1,3}),(?<room>\d{1,6})/m.exec @line

    @user.currentRoom = new Room if not @user.currentRoom
    @user.currentRoom.map = result.groups.map
    @user.currentRoom.room = result.groups.room

    @user.currentRoom.reRead()

    @user.onUserProfile @user.currentRoom.map, @user.currentRoom.room

    super.process()