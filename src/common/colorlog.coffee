options = require '../config/options.coffee'

colors =
    reset: "\u001B[0m"
    bright: "\u001B[1m"
    dim: "\u001B[2m"
    underscore: "\u001B[4m"
    blink: "\u001B[5m"
    reverse: "\u001B[7m"
    hidden: "\u001B[8m"
    fg:
        black: "\u001B[30m"
        red: "\u001B[31m"
        green: "\u001B[32m"
        yellow: "\u001B[33m"
        blue: "\u001B[34m"
        magenta: "\u001B[35m"
        cyan: "\u001B[36m"
        white: "\u001B[37m"
        crimson: "\u001B[38m"
    bg:
        black: "\u001B[40m"
        red: "\u001B[41m"
        green: "\u001B[42m"
        yellow: "\u001B[43m"
        blue: "\u001B[44m"
        magenta: "\u001B[45m"
        cyan: "\u001B[46m"
        white: "\u001B[47M"
        crimson: "\u001B[48m"

logCheck = (level, module) ->
    return options.logLevels.indexOf(level.toLowerCase()) <= options.logLevels.indexOf(options.logLevel.toLowerCase()) if module is undefined or options.logModule[module] is undefined
    options.logLevels.indexOf(level.toLowerCase()) <= options.logLevels.indexOf(options.logModule[module])

logFormat = (level, module, message, skip = false, color = colors.reset) ->
    str = if skip then '' else "#{color}#{module.toUpperCase().padStart(12, ' ')}:#{level.toUpperCase().padStart(7, ' ')}: "
    str + "#{message}#{colors.reset}"

toStdout = (level, module, message) ->
    return unless logCheck(level, module)
    process.stdout.write logFormat(level, module, message, true) unless message.trim() is ''

toConsole = (level, module, message, skip = false) ->
    return unless logCheck(level, module)
    return if message.trim() is ''
    color = switch
        when level.toLowerCase() is 'error' then colors.fg.red
        when level.toLowerCase() is 'warn' then colors.fg.yellow
        when level.toLowerCase() is 'silly' then colors.fg.crimson
        when level.toLowerCase() is 'debug' then colors.fg.blue
        else colors.reset

    console.log logFormat(level, module, message, skip, color)

module.exports = { colors, toStdout, toConsole }