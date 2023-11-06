extensions  = require '../common/extensions'
meta    = require '../engine/meta.coffee'
MudBlock = require './MudBlock.coffee'
Items = require '../classes/items.coffee'

@classes  = meta 'classes', yes # classes to add to the html element
@match    = meta 'match' # regex to match this block
@commands   = meta 'commands' # allowable commands for this block

@classes ['inventory'],
@match /^Encumbrance:\s+\d+/m,
@commands ['i', 'in', 'inv', 'inventory', (x) -> x.word(0) in "equip".getSubsets(1) and x.word(1) is undefined],
class UserInventory extends MudBlock
  @child = MudBlock.derived.add this

  process: ->
    invre   = /^You are carrying (?:Nothing!|(?<items>.+)).+(?:You have the following keys: (?<keys>.+)\.|You have no keys\.).+Wealth: (?<wealth>\d+) copper farthings.+Encumbrance: (?<encum>\d+)\/(?<maxenc>\d+) - (?<weight>\w+) \[\d+%\].*$/s
    result  = invre.exec @line

    @user.inventory.items   = Items.from result?.groups.items
    @user.inventory.keys    = Items.from result?.groups.keys
    @user.inventory.wealth  = parseInt result?.groups.wealth
    @user.inventory.encum   = parseInt result?.groups.encum
    @user.inventory.maxencum  = parseInt result?.groups.maxenc
    @user.inventory.weight  = result?.groups.weight
    super.process()

  json: -> super.json {
    items: @user.inventory.items?.map (element) -> element.json()
    keys: @user.inventory.keys?.map (element) -> element.json()
    wealth: @user.inventory.wealth
    encum: @user.inventory.encum
    maxencum: @user.inventory.maxencum
  }
