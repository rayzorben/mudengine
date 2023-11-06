extensions = require '../common/extensions.coffee'
alignments = require './alignments.coffee'
races = require './races.coffee'
classes = require './classes.coffee'
persist = require '../engine/persist.coffee'

class Player
  Object.defineProperties @prototype,
    alignment:
      get: -> @_alignment
      set: (value) -> @_alignment = alignments.fromString value

  constructor: (@id, @first, @last, alignment, @flags, @title, @gang, @ops) ->
    @alignment = alignment

  update: (id, first, last, alignment, flags, title, gang, ops) ->
    @id = id
    @first = first
    @last = last
    @alignment = alignment
    @flags = flags
    @title = title
    @gang = gang
    @ops = ops
    @class = classes.findClassByTitle @title
    # update the level if it differs from what we know
    @level = classes.findLevelByTitle @title unless @level and @level.isInRange(classes.findLevelByTitle @title)
    @lastOnline = Date.formatNow()
    @save()

  save: -> persist.upsert { user: @id, type: "who", first: @first }, @

  gossipOn: -> @flags.toLowerCase() is 'x'
  isOp: -> @ops.toLowerCase() in ['m', 's']
  isMudop: -> @ops.toLowerCase() is 'm'
  isSysop: -> @ops.toLowerCase() is 's'
  isSelf: (user) -> @first is user.status.first

  @fromWhoList: (id, line) ->
    players = []
    patternText = "^\\s*( {8}|#{alignments.getUniqueAlignments().join('|')}) (\\w+) (\\w+)? *([-x])  (#{classes.getUniqueTitles().join('|')}) *(?: of ([\\w ]+?)(?=(?: (?:M|S))? *$))?(?: (M|S))?$"
    pattern = new RegExp patternText, "gm"

    while result = pattern.exec line
      [ alignment, first, last, flags, title, gang, ops ] = result[1..]
      doc = await persist.one { id: id, type: "who", first: first }
      player = new Player doc

      player.update id, first, last, alignment, flags, title, gang, ops
      players.push player
    players

  @lookup: (id, first) ->
    doc = await persist.one { id: id, type: "who", first: first }
    new Player doc

if not module.parent
  soul = await Player.fromWhoList 1, "    Good Soul Guardian    -  Warrior Novice of The Guardians"
  console.log soul

module.exports = Player
