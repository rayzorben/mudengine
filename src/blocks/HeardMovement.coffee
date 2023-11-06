meta    = require '../engine/meta.coffee'
MudBlock = require './MudBlock.coffee'

@match    = meta 'match' # regex to match this block

@match /^You hear movement to the \w+\./m,
class HeardMovement extends MudBlock
  @child = MudBlock.derived.add this