extensions  = require '../common/extensions'
meta    = require '../engine/meta.coffee'
MudBlock = require './MudBlock.coffee'
Item = require './Item.coffee'

@matches    = meta 'matches', yes
@commands   = meta 'commands' # allowable commands for this block

@matches [ /^You are now wearing (?<item>[\w ]+)\.$/m, /^You lit the (?<item>[\w ]+)\.$/m ],
@commands [..."wear".getSubsets(2), ..."equip".getSubsets(1), ..."arm".getSubsets(1), "ready", "use"],
class UserEquipped extends MudBlock
  @child = MudBlock.derived.add this

  process: ->
    item = new Item @matched.item
    @user.onEquip item
    super.process()
