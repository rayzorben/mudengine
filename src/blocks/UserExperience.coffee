extensions  = require '../common/extensions'
meta    = require '../engine/meta.coffee'
MudBlock = require './MudBlock.coffee'

@classes  = meta 'classes', yes # classes to add to the html element
@match    = meta 'match' # regex to match this block
@commands   = meta 'commands' # allowable commands for this block

@classes ['experience'],
@match /^Exp: (?<exp>\d+) Level: (?<level>\d+) Exp needed for next level: (?<need>\d+) \((?<req>\d+)\) \[(?<per>\d+)%\]/,
@commands ['exp', 'experience'],
class UserExperience extends MudBlock
  @child = MudBlock.derived.add this

  process: ->
    @user.status.exp      = parseInt @matched.exp
    @user.status.level    = parseInt @matched.level
    @user.status.expneeded  = parseInt @matched.need
    @user.status.expreq     = parseInt @matched.req

    @user.onUserExperience @user.status

    super.process()