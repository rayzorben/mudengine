nedb = require '@seald-io/nedb'
path = require 'path'

db = new nedb(filename: path.join(__dirname, '../../resources/mudengine.db'), autoload: true)
db.ensureIndexAsync fieldName: [ 'user', 'type' ]

upsert = (id, document) ->
  await db.updateAsync id, { $set: document }, { upsert: true }
one = (id) ->
  await db.findOneAsync id

module.exports =
  upsert: upsert
  one: one
