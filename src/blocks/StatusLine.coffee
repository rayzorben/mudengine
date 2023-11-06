meta    = require '../engine/meta.coffee'
MudBlock = require './MudBlock.coffee'

@classes  = meta 'classes', yes # classes to add to the html element
@match    = meta 'match' # regex to match this block

@classes ['status-line'],
@match /^\[HP=(?<hp>\d{1,4})(?:\/(?<type>MA|KAI)=(?<mana>\d{1,3}))?(?:\s\((?<statea>Resting|Meditating)\)\s)?\]:(?:\s\((?<stateb>Resting|Meditating)\))?/m,
class StatusLine extends MudBlock
  @child = MudBlock.derived.add this

  json: ->
    super.json {
      hp:   @hp
      mana:   @mana
      type:   @type
      state:  @state
    }

  process: ->
    return unless result = @match.exec @line

    @hp   = parseInt result?.groups.hp
    @ma   = parseInt result?.groups.mana
    @type   = result?.groups.type
    @state  = result?.groups.statea or result?.groups.stateb

    @user.onGameEnter() unless @user.inRealm()
    @user.inRealm true

    @user.onStatusLine this, @hp, @ma, @type, @state
    super.process()