nedb = require '@seald-io/nedb'
path = require 'path'
options = require '../config/options.coffee'

db = new nedb(filename: options().persistdb, autoload: true)
db.ensureIndexAsync fieldName: [ 'user', 'type' ]

upsert = (id, document) ->
  await db.updateAsync id, { $set: document }, { upsert: true }
one = (id) ->
  await db.findOneAsync id

module.exports =
  upsert: upsert
  one: one
