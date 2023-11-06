extensions  = require '../common/extensions'
meta    = require '../engine/meta.coffee'
MudBlock = require './MudBlock.coffee'

@match    = meta 'match' # regex to match this block

@match /^\u001B\[K\u001B\[0;32m(?<player>You|[\w]+) (?<action>.*)(?:\.|!|\*)$/m,
class UserAction extends MudBlock
  @child = MudBlock.derived.add this

  test: (ansi) ->
    return true if @match.test ansi

  process: ->
    return unless result = @match.exec @ansi
    @user.onPlayerAction @line, result.groups.player, result.groups.action
    super.process()