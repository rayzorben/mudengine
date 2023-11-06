meta    = require '../engine/meta.coffee'
MudBlock = require './MudBlock.coffee'

@match    = meta 'match' # regex to match this block

@match /^Sneaking.../m,
class UserSneaking extends MudBlock
  @child = MudBlock.derived.add this

  process: ->
    @user.onSneak yes
    super.process()

module.exports = UserSneaking