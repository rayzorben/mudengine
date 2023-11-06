extensions  = require '../common/extensions'
meta    = require '../engine/meta.coffee'
MudBlock = require './MudBlock.coffee'

@classes  = meta 'classes', yes # classes to add to the html element
@match    = meta 'match' # regex to match this block
@commands   = meta 'commands' # allowable commands for this block

@classes ['status'],
@match /Willpower:\s+\d{2,3}/m,
@commands ['st', 'sta', 'stat', 'status'],
class UserStatus extends MudBlock
  @child = MudBlock.derived.add this

  process: ->
    result = /^Name:\s+(?<first>\w+) (?<last>\w*)\s+Lives\/CP:\s+(?<lives>\d+)\/(?<cp>\d+)/m.exec @line

    @user.status.first  = result?.groups.first;
    @user.status.last   = result?.groups.last;
    @user.status.lives  = parseInt result?.groups.lives
    @user.status.cp     = parseInt result?.groups.cp

    result = /^Race:\s+(?<race>[\w-]+)\s+Exp:\s+(?<exp>\d+)\s+Perception:\s+(?<perception>\d+)/m.exec @line

    @user.status.race     = result?.groups.race;
    @user.status.exp      = parseInt result?.groups.exp
    @user.status.perception   = parseInt result?.groups.perception

    result = /^Class:\s+(?<class>\w+)\s+Level: (?<level>\d+)\s+Stealth:\s+(?<stealth>\d+)/m.exec @line

    @user.status.class  = result?.groups.class;
    @user.status.level  = parseInt result?.groups.level
    @user.status.stealth  = parseInt result?.groups.stealth

    result = /^Hits:\s+(?<hp>\d+)\/(?<hpmax>\d+)\s+Armour Class:\s+(?<ac>\d+)\/(?<dr>\d+)\s+Thievery:\s+(?<thievery>\d+)/m.exec @line

    @user.health.hp     = parseInt result?.groups.hp
    @user.health.hpmax  = parseInt result?.groups.hpmax
    @user.status.ac     = parseInt result?.groups.ac
    @user.status.dr     = parseInt result?.groups.dr
    @user.status.thievery = parseInt result?.groups.thievery

    result = /^(?:(?:Mana|Kai):\s+(?<ma>\d+)\/(?<mamax>\d+))?\s+(?:Spellcasting:\s+(?<sc>\d+)\s+)?Traps:\s+(?<traps>\d+)/m.exec @line

    @user.health.ma     = parseInt result?.groups.ma
    @user.health.mamax  = parseInt result?.groups.mamax
    @user.status.traps  = parseInt result?.groups.traps

    result = /^\s+Picklocks:\s+(?<picks>\d+)/m.exec @line

    @user.status.picklocks = parseInt result?.groups.picks

    result = /^Strength:\s+(?<strength>\d+)\s+Agility:\s+(?<agility>\d+)\s+Tracking:\s+(?<tracking>\d+)/m.exec @line

    @user.status.strength = parseInt result?.groups.strength
    @user.status.agility  = parseInt result?.groups.agility
    @user.status.tracking = parseInt result?.groups.tracking

    result = /^Intellect:\s+(?<intellect>\d+)\s+Health:\s+(?<health>\d+)\s+Martial Arts:\s+(?<martial>\d+)/m.exec @line

    @user.status.intellect  = parseInt result?.groups.intellect
    @user.status.health     = parseInt result?.groups.health
    @user.status.martialarts  = parseInt result?.groups.martial

    result = /^Willpower:\s+(?<willpower>\d+)\s+Charm:\s+(?<charm>\d+)\s+MagicRes:\s+(?<mres>\d+)/m.exec @line

    @user.status.willpower  = parseInt result?.groups.willpower
    @user.status.charm    = parseInt result?.groups.charm
    @user.status.magicres   = parseInt result?.groups.mres

    @user.onStatus @user.status
    super.process()