meta    = require '../engine/meta.coffee'
MudBlock = require './MudBlock.coffee'

@classes  = meta 'classes', yes # classes to add to the html element
@match    = meta 'match' # regex to match this block

@classes ['realm-move', 'disconnect'],
@match /^(?<player>\w+) just disconnected!!!./m,
class PlayerDisconnects extends MudBlock
  @child = MudBlock.derived.add this
  json: -> super.json { source: @source }

  process: ->
    return unless result = @match.exec @line
    @source = result?.groups.player
    @user.onPlayerDisconnect @source
    super.process()