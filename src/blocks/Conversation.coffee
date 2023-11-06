meta    = require '../engine/meta.coffee'
MudBlock = require './MudBlock.coffee'

@classes  = meta 'classes', yes # classes to add to the html element
@match    = meta 'match' # regex to match this block
@command  = meta 'command' # for conversations with @command

@classes ['conversation'],
@match /^@(?<command>[A-Za-z-]+)\s?(?<args>.*)$/m,
@command no,
class Conversation extends MudBlock
  @child = MudBlock.derived.add this
  json: -> super.json { source: @source, message: @message }

  process: ->
    return unless result = @match.exec @line
    @source   = result.groups.player
    @message  = result.groups.message

    @handle() if @command
    return super.process()

  handle: ->
    return unless result = /^@(?<command>[A-Za-z-]+)\s?(?<args>.*)$/m.exec @message
    @user.onMessageCommand this, result.groups.command, result.groups.args

module.exports = Conversation