extensions  = require '../common/extensions'
meta    = require '../engine/meta.coffee'
MudBlock = require './MudBlock.coffee'
UserSneaking = require './UserSneaking.coffee'

@match    = meta 'match' # regex to match this block
@commands   = meta 'commands' # allowable commands for this block

@match /^Attempting to sneak\.\.\.$/m,
@commands ["sneak".getSubsets(1)],
class UserSneakInitiate extends UserSneaking
  @child = MudBlock.derived.add this