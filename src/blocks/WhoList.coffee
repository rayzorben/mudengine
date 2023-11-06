extensions  = require '../common/extensions'
meta    = require '../engine/meta.coffee'
MudBlock = require './MudBlock.coffee'
Player = require '../classes/player.coffee'

@classes  = meta 'classes', yes # classes to add to the html element
@match    = meta 'match' # regex to match this block
@commands   = meta 'commands' # allowable commands for this block

@classes ['who'],
@match /Current Adventurers/m,
@commands [..."who".getSubsets(1), ..."scan".getSubsets(1)],
class WhoList extends MudBlock
  @child = MudBlock.derived.add this

  process: ->
    return false unless result = @match.exec @line
    return false unless /.*\u001B\[79D$/.test @ansi

    Player.fromWhoList @user.id, @line
    .then (players) =>
      @user.who = players
      @user.onWho player for player in @user.who

    super.process()
