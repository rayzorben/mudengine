meta    = require '../engine/meta.coffee'
MudBlock = require './MudBlock.coffee'
Prompt = require './Prompt.coffee'

@match    = meta 'match' # regex to match this block

@match /^Please enter your password:/m,
class PromptPassword extends Prompt
  @child = MudBlock.derived.add this
  process: ->
    @response @user.config.password unless @user.loggedIn
    super.process
