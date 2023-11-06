meta    = require '../engine/meta.coffee'
MudBlock = require './MudBlock.coffee'

@classes  = meta 'classes', yes # classes to add to the html element
@match    = meta 'match' # regex to match this block

@classes ['user', 'combat', 'hit'],
@match /^(?<source>[\w]+) (?:critically )?(?:\w+) (?<target>[\w- ]+) for (?<damage>\d+) damage!/,
class UserHits extends MudBlock
  @child = MudBlock.derived.add this

  process: ->
    return unless result = @match.exec @line

    source  = @matched.source
    target  = @matched.target
    damage  = parseInt @matched.damage
    @user.onCombatHit source, target, damage
    super.process()
