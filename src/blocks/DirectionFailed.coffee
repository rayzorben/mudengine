meta    = require '../engine/meta.coffee'
MudBlock = require './MudBlock.coffee'
RoomBase = require './RoomBase.coffee'

@matches  = meta 'matches', yes # array of regexes that match
@failure = meta 'failure'

@failure true,
@matches [ /^There is no exit in that direction!$/m, /^The (?:door|gate) is closed(?: in that direction)?!/m ],
class DirectionFailed extends RoomBase
  @child = MudBlock.derived.add this

  process: ->
    @user.onCommandFailed "direction-failed"
    super.process()