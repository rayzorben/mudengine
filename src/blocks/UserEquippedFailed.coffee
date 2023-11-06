extensions  = require '../common/extensions'
meta    = require '../engine/meta.coffee'
MudBlock = require './MudBlock.coffee'

@match    = meta 'match' # regex to match this block
@commands   = meta 'commands' # allowable commands for this block

@match /^You may not wear that item!$/m,
@commands [..."wear".getSubsets(2), ..."equip".getSubsets(1), ..."arm".getSubsets(1), "ready"],
class UserEquippedFailed extends MudBlock
  @child = MudBlock.derived.add this

  process: ->
    @user.onCommandFailed "equip-failed"
    super.process()
