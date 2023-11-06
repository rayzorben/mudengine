meta    = require '../engine/meta.coffee'
MudBlock = require './MudBlock.coffee'

@match    = meta 'match' # regex to match this block

@match /^Your command had no effect.$/m,
class CommandNoEffect extends MudBlock
  @child = MudBlock.derived.add this

  process: (command) ->
    @user.onCommandFailed "command-no-effect", command
    super.process()
