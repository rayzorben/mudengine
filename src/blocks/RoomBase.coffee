extensions  = require '../common/extensions'
meta    = require '../engine/meta.coffee'
MudBlock = require './MudBlock.coffee'

@commands   = meta 'commands' # allowable commands for this block

@commands ['\n', 'n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se', 'u', 'd', ..."look".getSubsets(), (x) -> x.word(0) is 'sys' and x.word(1) is 'goto' ],
class RoomBase extends MudBlock

module.exports = RoomBase