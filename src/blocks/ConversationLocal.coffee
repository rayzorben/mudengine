meta    = require '../engine/meta.coffee'
MudBlock = require './MudBlock.coffee'
Conversation = require './Conversation.coffee'

# classes used for html
@classes  = meta 'classes', yes # classes to add to the html element
@match    = meta 'match' # regex to match this block
@command  = meta 'command' # for conversations with @command

@classes ['local'],
@match /^(?<player>\w+) says? "(?<message>.+)"/m,
@command yes,
class ConversationLocal extends Conversation
  @child = MudBlock.derived.add this
  process: ->
    value = super.process()
    @user.onLocal this, @source, @message
    return value

  reply: (message) -> @user.sendline ".#{message}"