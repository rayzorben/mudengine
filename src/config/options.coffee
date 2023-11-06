globalOptions =
    database: '../../resources/gmud20230902.sqlite'
    ui:
        maxHistoryLines: 99000
    engine:
        maxQueuedCommands: 20
        idleCommandSend: 30
        allOn: yes
    logLevels: ['error', 'warn', 'info', 'verbose', 'debug', 'silly']
    logLevel: 'info'
    logModule:
        user: 'debug'
        ansi: 'debug'
        keyboard: 'error'
        userEvent: 'error'
        buffer: 'error'
        blockRoom: 'debug'
        fixMobs: 'debug'
        Room: 'debug'
    maxConversationsByType: 30

module.exports = globalOptions