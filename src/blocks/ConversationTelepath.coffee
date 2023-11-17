meta    = require '../engine/meta.coffee'
MudBlock = require './MudBlock.coffee'
Conversation = require './Conversation.coffee'

@classes  = meta 'classes', yes # classes to add to the html element
@match    = meta 'match' # regex to match this block
@command  = meta 'command' # for conversations with @command
@commands = meta 'commands', yes

@classes ['telepath'],
@match /^(?<player>\w+) telepaths: (?<message>.+)/m,
@command yes,
class ConversationTelepath extends Conversation
  @child = MudBlock.derived.add this

  process: ->
    vaue = super.process()
    @user.onTelepath this, @source, @message
    return value

  reply: (message) -> @user.sendline "/#{@source} #{message}"

@match /^--- Telepath sent to (?<player>\w+) ---$/m,
@commands [ (x) -> x.startsWith('/') ],
class ConversationTelepathSent extends Conversation
  @child = MudBlock.derived.add this