extensions = require '../common/extensions.coffee'
meta    = require '../engine/meta.coffee'
MudBlock = require './MudBlock.coffee'
Items = require '../classes/items.coffee'

@classes  = meta 'classes', yes # classes to add to the html element
@match    = meta 'match' # regex to match this block
@commands   = meta 'commands' # allowable commands for this block

@classes ['items', 'hidden'],
@match /^You notice (?<items>.*)(?:\r\n| )/,
@commands [..."search".getSubsets(2)],
class HiddenItems extends MudBlock
  @child = MudBlock.derived.add this

  process: ->
    match = /^You notice (?<items>.*)(?:\r\n| )here\./
    return false unless result = match.exec @line

    @user.currentRoom?.hidden = Items.from result.groups.items
    @user.onHiddenItems @user.currentRoom?.hidden

    super.process()

  json: ->
    super.json {
      items: @user.currentRoom?.hidden?.map (element) -> element.json()
    }