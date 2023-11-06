meta    = require '../engine/meta.coffee'
MudBlock = require './MudBlock.coffee'

@match    = meta 'match' # regex to match this block

@match /^You make a sound as you enter the room!/m,
class UserNotSneaking extends MudBlock
  @child = MudBlock.derived.add this

  process: ->
    @user.onSneak no
    super.process()

module.exports = UserNotSneaking