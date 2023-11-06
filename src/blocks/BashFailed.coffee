extensions  = require '../common/extensions'
meta = require '../engine/meta.coffee'
MudBlock = require './MudBlock.coffee'

@match = meta 'match' # regex to match this block
@commands = meta 'commands' # allowable commands for this block
@failure = meta 'failure'

@failure true,
@match /^Your attempts to bash through fail!$/m,
@commands [..."bash".getSubsets(2)],
class BashFailed extends MudBlock
  @child = MudBlock.derived.add this

  process: ->
    @user.onCommandFailed "bash-failed"
    super.process()