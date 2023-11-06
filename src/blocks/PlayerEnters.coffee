meta    = require '../engine/meta.coffee'
MudBlock = require './MudBlock.coffee'

@classes  = meta 'classes', yes # classes to add to the html element
@match    = meta 'match' # regex to match this block

@classes ['realm-move', 'enter'],
@match /^(?<player>\w+) just entered the Realm./m,
class PlayerEnters extends MudBlock
  @child = MudBlock.derived.add this
  json: -> super.json { source: @source }

  process: ->
    return unless result = @match.exec @line

    @user.idleCommand 'who'
    @source = result?.groups.player
    @user.onPlayerEnter @source
    super.process()