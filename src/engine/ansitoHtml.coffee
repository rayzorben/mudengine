log = require '../common/colorlog.coffee'

class AnsiToHtml
    constructor: ->
        @document = parseDom()
        @bold = false
        @fg = @defaultfg = 37
        @bg = @defaultbg = 40

        @sequences = /(\x1B\[[0-9;]*[ABCDEFGHJKSTfmpsu]|\x1B[A-Za-z]|[^]+?(?=(\x1B|$)))/g
        @ansi = /^(\x1B\[[0-9;]*[ABCDEFGHJKSTfmpsu]|\x1B[A-Za-z])$/

        @ansiColor = /^(\x1B\[[0-9;]*m)$/
        @ansiCursor = /^\u001B\[(?<count>\d*)(?<direction>[A-D])/

    parseDom = (html) ->
        if typeof DOMParser isnt 'undefined'
            log.toConsole 'silly', 'ansi', 'using DOMParser'
            new DOMParser().parseFromString(html, 'text/html')
        else
            log.toConsole 'silly', 'ansi', 'using JSDOM'
            { JSDOM } = require 'jsdom'
            dom = new JSDOM(html)
            dom.window.document

    ansiReset: ->
        @fg = @defaultfg
        @bg = @defaultbg
        @bold = false

    convert: (ansi, props) ->
        @document.body.innerHTML = ''
        @dom = @document.body

        ###
        split by newlines keeping the newline with the preceding text
        ###
        ansi.split /(?<=[\n?!])/
        .forEach (line) =>
            #TODO: get rid of line
            @current = @createSpan  "line"

            for key, value of props
                if key is 'classes'
                    existingClasses = @current.className.split(' ')
                    @current.className = (existingClasses.concat(value)).join(' ')
                else if key.startsWith('data-')
                    @current.setAttribute(key, value)
                else
                    @current[key] = value
            @dom.appendChild @current

            # for each ansi sequence or text
            line.match @sequences
            ?.forEach (sequence) =>
                log.toConsole 'silly', 'ansi', 'sequence: ' + sequence.replaceAll /\u001B/g, ''
                if @ansi.test sequence
                    @evaluateAnsiClass sequence
                else
                    log.toConsole 'silly', 'ansi', "text: #{sequence} fg #{@fg} bg #{@bg}"
                    span = @createSpan()
                    span.classList.add "ansi-fg-#{@fg}#{if @bold then '-bright' else ''}"
                    span.classList.add "ansi-bg-#{@bg}"
                    span.appendChild @document.createTextNode sequence
                    @current.appendChild span

        @dom.innerHTML

    evaluateAnsiClass: (sequence) ->
        switch
            when @ansiColor.test sequence then @handleColor sequence
            when @ansiCursor.test sequence then @handleCursor sequence
            when /\u001B\[\d*J/.test sequence then @handleClearScreen sequence
            when /\u001B\[\d?K/.test sequence then @handleClearLine sequence
            when /\u001B\[\d+;\d+H/.test sequence then @handleCursorPosition sequence
            else log.toConsole 'debug', 'ansi', "Sequence #{sequence.replaceAll /\u001B/g, ''} not handled."

    handleColor: (sequence) ->
        for color in @getColorCodes sequence
            @ansiReset() if +color == 0
            @bold = true if +color == 1
            @fg = +color if +color >= 30 and +color <= 37
            @bg = +color if +color >= 40 and +color <= 47

    getColorCodes: (input) ->
        colorPattern = /\x1B\[([0-9;]*)m/

        match = input.match colorPattern
        result = if match then match[1].split ';' else []
        result

    handleCursor: (sequence) ->
        result = @ansiCursor.exec sequence
        count = if result then result.groups.count else 1
        direction = switch
            when result?.groups.direction == "A" then "up"
            when result?.groups.direction == "B" then "down"
            when result?.groups.direction == "C" then "forward"
            when result?.groups.direction == "D" then "back"

        span = @createSpan "cursor-#{direction}"
        span.innerHTML = " ".repeat count
        @current.appendChild span

    handleClearScreen: (sequence) ->
        result = /\u001B\[(?<command>\d*)J/.exec sequence
        command = if result then result.groups.command else 0
        switch
            when command >= 2 and command <= 3
                span = @createSpan "ansi-clearScreen"
                @current.appendChild span

    handleClearLine: (sequence) ->
        result = /\u001B\[(?<count>\d*)K/.exec sequence
        count = if result then result.groups.count else 0
        span = @createSpan "ansi-clearLine"
        @current.appendChild span

    handleCursorPosition: (sequence) ->
        result = /\u001B\[(?<row>\d+);(?<col>\d+)H/.exec sequence
        row = if result then result.groups.row - 1 else 0
        col = if result then result.groups.col - 1 else 0

        span = @createSpan "ansi-cursorPosition"
        span.dataset.row = row
        span.dataset.column = col
        @current.appendChild span

    createSpan: (classes) ->
        span = @document.createElement 'span'
        if Array.isArray classes
            span.classList.add ...classes
        else if classes
            span.classList.add classes
        span

module.exports = { AnsiToHtml }