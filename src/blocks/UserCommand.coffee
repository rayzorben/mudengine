meta    = require '../engine/meta.coffee'
MudBlock = require './MudBlock.coffee'

@classes  = meta 'classes', yes # classes to add to the html element

@classes ['user-command'],
class UserCommand extends MudBlock
  process: -> super.process()
  html: -> "<#{ @element } class=\"#{ @classes.join(' ') }\">#{ @ansi }</#{ @element }>"

module.exports = UserCommand