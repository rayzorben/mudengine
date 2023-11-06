meta    = require '../engine/meta.coffee'
Prompt  = require './Prompt.coffee'
MudBlock = require './MudBlock.coffee'

@match    = meta 'match' # regex to match this block

@match /^Please select a realm:/m,
class PromptRealm extends Prompt
  @child = MudBlock.derived.add this
  process: ->
    @response @user.config.realm
    super.process()