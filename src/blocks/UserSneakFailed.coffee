extensions  = require '../common/extensions'
meta    = require '../engine/meta.coffee'
MudBlock = require './MudBlock.coffee'
UserNotSneaking = require './UserNotSneaking.coffee'

@match    = meta 'match' # regex to match this block
@commands   = meta 'commands' # allowable commands for this block

@match /^Attempting to sneak\.\.\.You don't think you're sneaking\./m,
@commands ["sneak".getSubsets(1)],
class UserSneakFailed extends UserNotSneaking
  @child = MudBlock.derived.add this