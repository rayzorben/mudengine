extensions  = require '../common/extensions'
meta    = require '../engine/meta.coffee'
MudBlock = require './MudBlock.coffee'
Conversation = require './Conversation.coffee'

# classes used for html
@classes  = meta 'classes', yes # classes to add to the html element
@match    = meta 'match' # regex to match this block
@command  = meta 'command' # for conversations with @command
@commands   = meta 'commands' # allowable commands for this block

@classes ['gangpath'],
@match /^(?<player>\w+) gangpaths: (?<message>.+)/m,
@command yes,
@commands ['gb', 'bg', ..."broadgang".getSubsets(5)],
class ConversationGangpath extends Conversation
  @child = MudBlock.derived.add this

  process: ->
    value = super.process()
    @user.onGangpath this, @source, @message
    return value

  reply: (message) -> @user.sendline "gb #{message}"