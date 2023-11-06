meta    = require '../engine/meta.coffee'
MudBlock = require './MudBlock.coffee'

@match    = meta 'match' # regex to match this block

@match /^You gain (?<exp>\d+) experience./m,
class UserGainExperience extends MudBlock
  @child = MudBlock.derived.add this

  process: ->
    @user.onUserGainExperience parseInt @matched.exp
    super.process()