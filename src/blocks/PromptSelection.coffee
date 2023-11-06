meta    = require '../engine/meta.coffee'
MudBlock = require './MudBlock.coffee'
Prompt  = require './Prompt.coffee'

@match    = meta 'match' # regex to match this block

@match /^Please enter your selection:/m,
class PromptSelection extends Prompt
  @child = MudBlock.derived.add this
  process: ->
    @user.loggedIn = true
    @response 'p'
    super.process()
