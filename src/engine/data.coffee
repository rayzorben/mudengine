sqlite3 = require 'better-sqlite3'
path = require 'path'
options = require '../config/options'

_db = null

init = ->
  if not _db
    _db = new sqlite3 path.resolve(__dirname, options().database)
    _db.pragma 'journal_mode = WAL'
  _db

close = ->
  return unless _db
  _db.close (err) ->
    throw err if err
    console.log 'Database closed'

data = init()

rooms =
  queryAllRooms: data.prepare "SELECT * FROM Rooms"
  queryByNameLike: data.prepare "SELECT [Name], [Map Number] AS Map, [Room Number] AS Room FROM Rooms WHERE name LIKE ?"
  queryByName: data.prepare "SELECT * FROM Rooms WHERE Name=?"
  queryByLocation: data.prepare "SELECT [Name], [Map Number] AS Map, [Room Number] AS Room FROM Rooms WHERE [Map Number]=? AND [Room Number]=?"
  queryByExits: data.prepare "SELECT * FROM Rooms WHERE Name=? AND N <> ? AND S <> ? AND E <> ? AND W <> ? AND NW <> ? AND NE <> ? AND SE <> ? AND SW <> ? AND U <> ? AND D <> ?"
  queryById: data.prepare "SELECT * FROM Rooms WHERE [Map Number] = ? AND [Room Number] = ?"
  allRooms: -> rooms.queryAllRooms.all()
  byNameLike: (match) -> rooms.queryByNameLike.all "%#{match}%"
  byName: (name) -> rooms.queryByName.all name
  byLocation: (map, room) -> rooms.queryByLocation.all map, room
  byExits: (args...) -> rooms.queryByExits.all args...
  byId: (map, room) -> rooms.queryById.get map, room

monsters =
  queryMobByName: data.prepare "SELECT * FROM Monsters WHERE Name = ?"
  queryMobSummon: data.prepare "SELECT * FROM Monsters WHERE Name = ? AND [Summoned By] LIKE ?"
  byName: (name) -> monsters.queryMobByName.all name
  bySummon: (name, map, room) -> monsters.queryMobSummon.all name, "%Room #{map}/#{room}%"
  bySummonMap: (name, map) -> monsters.queryMobSummon.all name, "%Group%: #{map}/%"
  byList: (names) ->
    query = data.prepare "SELECT * FROM Monsters WHERE Name IN (#{Array(names.length).fill('?').join(',')})"
    query.all names

shops =
  queryShop: data.prepare "SELECT * FROM Shops WHERE Number = ?"
  byId: (id) -> shops.queryShop.get id

items =
  queryByName: data.prepare "SELECT * FROM Items WHERE Name = ?"
  byName: (name) -> items.queryByName.get name

module.exports =
  db: data
  rooms: rooms
  monsters: monsters
  shops: shops
  items: items