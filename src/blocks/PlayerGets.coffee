extensions = require '../common/extensions.coffee'
meta = require '../engine/meta.coffee'
MudBlock = require './MudBlock.coffee'

@match = meta 'match' # regex to match this block
@commands = meta 'commands' # allowable commands for this block

@match /^(?<player>[\w]+) picks up (?<item>.*)\./m,
class PlayerGets extends MudBlock
  @child = MudBlock.derived.add this
  
@match /^You took (?<item>.*)\./m,
@commands [..."get".getSubsets(0)],
class UserGets extends MudBlock
  @child = MudBlock.derived.add this