extensions  = require '../common/extensions'
meta    = require '../engine/meta.coffee'
MudBlock = require './MudBlock.coffee'

@match    = meta 'match' # regex to match this block
@commands   = meta 'commands' # allowable commands for this block

@match /^The following items are for sale here:$/m,
@commands [..."list".getSubsets(2)],
class UserList extends MudBlock
  @child = MudBlock.derived.add this
  
  # TODO: call @user.onItemForSale which will then check if user wants
  # to buy an item
  process: -> super.process()