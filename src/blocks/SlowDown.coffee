meta    = require '../engine/meta.coffee'
MudBlock = require './MudBlock.coffee'

@match    = meta 'match' # regex to match this block

@match /^Why don't you slow down for a few seconds\?/m,
class SlowDown extends MudBlock
  @child = MudBlock.derived.add this