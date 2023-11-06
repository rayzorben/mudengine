Item = require '../blocks/Item.coffee'

class Items extends Array
  @from: (items) ->
    return unless items

    result = new Items

    items.split /,(?:\r\n| )/
    .forEach (element) =>
      item = /(?:(?<qty>\d+) )*(?<name>[\w ]+)\s?(?:\((?<equipped>[A-Za-z ]+)(?:\/\d+)?\))?/.exec element
      result.push new Item item.groups.name.trim(), item.groups.qty, item.groups.equipped if item and item.groups

    return result
    
  #TODO: implement here vs in user.coffee
  removeItem: (name) ->

module.exports = Items