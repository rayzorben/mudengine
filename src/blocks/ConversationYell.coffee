extensions  = require '../common/extensions'
meta    = require '../engine/meta.coffee'
MudBlock = require './MudBlock.coffee'
Conversation = require './Conversation.coffee'

# classes used for html
@classes  = meta 'classes', yes # classes to add to the html element
@match    = meta 'match' # regex to match this block
@command  = meta 'command' # for conversations with @command
@commands   = meta 'commands' # allowable commands for this block

@classes ['yell'],
@match /^(?<player>\w+) yells "(?<message>.+)"/m,
@command yes,
class ConversationPlayerYells extends Conversation
  @child = MudBlock.derived.add this

  process: ->
    value = super.process()
    @user.onYell this, @source, @message
    return value

  reply: (message) -> @user.sendline ".#{message}"
  
@classes ['yell'],
@commands [ (x) -> x.startsWith('"') ],
@match /^You yell "(?<message>.+)"/m,
class ConversationUserYells extends Conversation
  @child = MudBlock.derived.add this

  process: ->
    value = super.process()
    @user.onYouYell this, @message
    return value