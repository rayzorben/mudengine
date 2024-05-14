Item = require '../blocks/Item.coffee'
log  = require '../common/colorlog'

class Items extends Array
  @from: (items) ->
    return unless items
    
    log.toConsole 'silly', 'items', "parsing items #{items}"

    result = new Items

    items = items.replaceAll(/\r\n/g, ' ')
    items = items.replaceAll(/\r/g, ' ').replaceAll(/\n/g, ' ')
    items.split /,/
    .forEach (element) =>
      item = / *(?:(?<qty>\d+) )*(?<name>[-'\w ]+)\s?(?:\((?<equipped>[A-Za-z ]+)(?:\/\d+)?\))?/.exec element
      log.toConsole 'silly', 'items', "parsing item #{item.groups.name.trim()} qty #{item.groups.qty} eq #{item.groups.equipped}" if item and item.groups
      result.push new Item item.groups.name.trim(), item.groups.qty, item.groups.equipped if item and item.groups

    return result
    
  #TODO: implement here vs in user.coffee
  removeItem: (name) ->

module.exports = Items