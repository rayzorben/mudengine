extensions = require '../common/extensions.coffee'
meta    = require '../engine/meta.coffee'
MudBlock = require './MudBlock.coffee'

@match    = meta 'match' # regex to match this block
@commands   = meta 'commands' # allowable commands for this block

@match /^(?<player>[\w]+) drops (?<item>.*)\./m,
class PlayerDrops extends MudBlock
  @child = MudBlock.derived.add this

@match /^You dropped (?<item>.*)\./m,
@commands [..."drop".getSubsets(1)],
class UserDrops extends MudBlock
  @child = MudBlock.derived.add this