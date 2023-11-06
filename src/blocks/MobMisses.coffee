meta    = require '../engine/meta.coffee'
MudBlock = require './MudBlock.coffee'

@match    = meta 'match' # regex to match this block

@match /^The (?<target>[\w -]+) \w+ at you\./m,
class MobMisses extends MudBlock
  @child = MudBlock.derived.add this

  process: ->
    return unless result = @match.exec @line
    @user.onMobMiss result.groups.target, result.groups.damage
    super.process()