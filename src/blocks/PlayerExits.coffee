meta    = require '../engine/meta.coffee'
MudBlock = require './MudBlock.coffee'

# classes used for html
@classes  = meta 'classes', yes # classes to add to the html element
@match    = meta 'match' # regex to match this block

@classes ['realm-move', 'exit'],
@match /^(?<player>\w+) just left the Realm./m,
class PlayerExits extends MudBlock
  @child = MudBlock.derived.add this
  json: -> super.json { source: @source }

  process: ->
    return unless result = @match.exec @line
    @source = result?.groups.player
    @user.onPlayerExit @source
    super.process()