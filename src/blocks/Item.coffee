data    = require '../engine/data.coffee'
MudBlock = require './MudBlock.coffee'

class Item extends MudBlock
  constructor: (@name, @qty = 1, @equipped = undefined) ->
    super()
    @merge result if result = data.items.byName @name

  json: -> super.json
    name: @name

module.exports = Item