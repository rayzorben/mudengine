meta = require '../engine/meta.coffee'
MudBlock = require './MudBlock.coffee'

@match = meta 'match' # regex to match this block

@match /^\*Combat (?<status>Engaged|Off)\*/m,
class CombatStatus extends MudBlock
  @child = MudBlock.derived.add this

  process: ->
    return unless result = @match.exec @line

    combaton = result.groups.status == "Engaged"

    @user.onCombatStatus combaton
    super.process()