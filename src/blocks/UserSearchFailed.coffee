extensions  = require '../common/extensions'
meta    = require '../engine/meta.coffee'
MudBlock = require './MudBlock.coffee'

@match    = meta 'match' # regex to match this block
@commands   = meta 'commands' # allowable commands for this block

@match /^You notice nothing different to the \w+$/m,
@commands [ ..."search".getSubsets(2) ],
class UserSearchFailed extends MudBlock
  @child = MudBlock.derived.add this

  process: ->
    @user.onCommandFailed "search-failed"
    super.process()
