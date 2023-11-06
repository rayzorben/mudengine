meta    = require '../engine/meta.coffee'
Prompt  = require './Prompt.coffee'
MudBlock = require './MudBlock.coffee'

@match    = meta 'match' # regex to match this block

@match /^\[PARADIGM\]:/m,
class PromptGreaterMud extends Prompt
  @child = MudBlock.derived.add this
  process: ->
    @response 'enter' unless @user.preventEnter
    super.process()