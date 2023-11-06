extensions  = require '../common/extensions'
meta = require '../engine/meta.coffee'
MudBlock = require './MudBlock.coffee'
Item = require './Item.coffee'

@match    = meta 'match' # regex to match this block
@commands   = meta 'commands' # allowable commands for this block

@match /^You just bought (?:(?<qty>\d+) )?(?<item>[\w ]+) for (?<price>\d+) copper farthings\.$/m,
@commands [..."buy".getSubsets(1)],
class UserBuys extends MudBlock
  @child = MudBlock.derived.add this

  process: ->
    return unless result = @match.exec @line
    item = new Item result.groups.item, result.groups.qty
    @user.onItemBuy item, result.price
    super.process()