meta = require '../engine/meta.coffee'
MudBlock = require './MudBlock.coffee'
Item = require './Item.coffee'

# classes used for html
@match    = meta 'match' # regex to match this block
@commands   = meta 'commands' # allowable commands for this block

@match /^You have removed (?<item>[\w ]+?)(?: and extinguished it)?\.$/m,
@commands [..."remove".getSubsets(2)],
class UserRemoved extends MudBlock
  @child = MudBlock.derived.add this

  process: ->
    return unless result = @match.exec @line
    item = new Item result.groups.item
    @user.onUnequip item
    super.process()