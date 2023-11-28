path = require 'path'
{ app } = require 'electron'

resourcePath = if app?.isPackaged then process.resourcesPath else path.join __dirname + "/../../resources"

console.log "resourcePath: #{resourcePath}"

globalOptions =
    database: path.join resourcePath, '/gmud20230902.sqlite'
    persistdb: path.join resourcePath, '/mudengine.db'
    ui:
        maxHistoryLines: 99000
        showDeveloperToolsOnLoad: false
    engine:
        maxQueuedCommands: 20
        idleCommandSend: 30
        allOn: yes
    logLevels: ['error', 'warn', 'info', 'verbose', 'debug', 'silly']
    logLevel: 'info'
    logModule:
        application: 'debug'
        user: 'debug'
        ansi: 'debug'
        keyboard: 'error'
        userEvent: 'error'
        buffer: 'error'
        blockRoom: 'debug'
        fixMobs: 'debug'
        Room: 'info'
        mobs: 'debug'
    maxConversationsByType: 30

module.exports = globalOptions