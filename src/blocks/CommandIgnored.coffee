meta    = require '../engine/meta.coffee'
MudBlock = require './MudBlock.coffee'

@match    = meta 'match' # regex to match this block
@failure = meta 'failure'

@failure true,
@match /^You are typing too quickly - command ignored/m,
class CommandIgnored extends MudBlock
  @child = MudBlock.derived.add this

  process: ->
    @user.onCommandFailed "command-ignored"
    super.process()