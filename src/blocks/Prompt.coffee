meta    = require '../engine/meta.coffee'
MudBlock = require './MudBlock.coffee'

@classes  = meta 'classes', yes # classes to add to the html element

@classes ['prompt'],
class Prompt extends MudBlock
  process: -> super.process()

module.exports = Prompt