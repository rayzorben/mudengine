extensions  = require '../common/extensions'
meta    = require '../engine/meta.coffee'
MudBlock = require './MudBlock.coffee'
UserNotSneaking = require './UserNotSneaking.coffee'

@match    = meta 'match' # regex to match this block
@commands   = meta 'commands' # allowable commands for this block

@match /^You may not sneak right now!/m,
@commands ["sneak".getSubsets(1)],
class UserCantSneak extends UserNotSneaking
  @child = MudBlock.derived.add this