extensions  = require '../common/extensions'
meta    = require '../engine/meta.coffee'
MudBlock = require './MudBlock.coffee'

@match    = meta 'match' # regex to match this block
@commands   = meta 'commands' # allowable commands for this block

@match /^You found an exit to the (?<direction>\w+)!/m,
@commands [ ..."search".getSubsets(2) ],
class UserSearchSucceeded extends MudBlock
  @child = MudBlock.derived.add this

  process: ->
    @user.onExitFound @matched.direction
    super.process()
