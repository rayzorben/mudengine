extensions  = require '../common/extensions'
meta    = require '../engine/meta.coffee'
MudBlock = require './MudBlock.coffee'

@match    = meta 'match' # regex to match this block
@commands   = meta 'commands' # allowable commands for this block

@match /^You hid (?<item>.*)\./m,
@commands [..."hide".getSubsets(2)],
class UserHides extends MudBlock
  @child = MudBlock.derived.add this
  
  process: ->
    @user.onHideItem @matched.item
    super.process()