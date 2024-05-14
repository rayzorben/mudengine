extensions = require '../common/extensions'
meta = require '../engine/meta.coffee'
log = require '../common/colorlog'

{ AnsiToHtml }  = require '../engine/ansitoHtml.coffee'

@classes  = meta 'classes', yes # classes to add to the html element

###
@description Basic block of text, common functions for all
###
@classes ['block'],
class MudBlock
  @derived = new Set
  _ansi = new AnsiToHtml()

  constructor: (@user, @ansi = '') ->
    @line       = @ansi.stripAnsi()
    @element    = "span"
    @properties   = { classes: @classes }

  @from: (user, ansi) ->
    UserCommand = require './UserCommand.coffee'

    for child from MudBlock.derived.values()
      factory = new child user, ansi
      if result = factory?.test ansi
        #TODO: implement all process blocks to use this
        factory.matched = result.groups
        return factory

    return ( ->
      log.toConsole 'silly', 'mudblock', "UserCommand because it was in the list of commands."
      new UserCommand user, ansi
    )() if ansi.stripAnsi().trim() in user.commands()
    return ( ->
      log.toConsole 'silly', 'mudblock', "UserCommand because line length was 1."
      new UserCommand user, ansi
    )() if ansi.length is 1
    return ( ->
      log.toConsole 'silly', 'mudblock', "UserCommand because line didn't contain ANSI."
      new UserCommand user, ansi
    )() if not ansi.containsAnsi()

    return new MudBlock user, ansi

  test: (ansi) ->
    return result if result = @match?.exec ansi.stripAnsi()
    return result.exec ansi.stripAnsi() if result = @matches?.find (match) -> match.exec ansi.stripAnsi()

  # json representation of this object
  json: (child) ->
    Object.assign {},
    {
      block:  @constructor.name
      line:   @line
      ansi:   @ansi
      html:   @html()
    },
    child

  # html representation of this object
  html: -> _ansi.convert @ansi, @properties

  process: -> return true

  response: (response = @_response) -> @_response = response

  merge: (child) ->
    Object.getOwnPropertyNames child
    .forEach (prop) => @[prop] = child[prop] if typeof child[prop] isnt 'function'
    #.forEach (prop) => @[prop] = child[prop] if not child[prop]? and typeof child[prop] isnt 'function'

#TODO: \d silver|copper|gold|runic drops to the ground.
#TODO: find death messages and remove them from the room or rescan
#The orc rogue collapses with a grunt.
#TODO: looking at a player
#TODO: Player stops to rest.
#TODO: Player ... check spell messages
#TODO: check random game messages?
#TODO: xxx moves to attack you!
#TODO: A mob oozes, creeps, etc into the room from the direction.

###
[ Winterhawk Testalot ]
Winterhawk is a colossal, physically Godlike Dwarf Paladin with no hair and
black eyes. He moves blindingly fast, and is extremely likeable, and fairly
radiates charisma. Winterhawk appears to be all-knowing and looks like he is
one with the Gods. He is unwounded.

He is equipped with:

swamp boots          (Feet)
firebrand cape         (Back)
phoenix feather        (Neck)
sunstone wristband       (Wrist)
icehammer            (Weapon Hand)
###

module.exports = MudBlock
