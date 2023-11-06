extensions = require '../common/extensions'

class Viewport extends Array
    # takes attributes from NamedNodeMap and returns a dictionary
    attrToDict = (node) ->
        dict = {}
        dict[attr.name] = attr.value for attr in node.attributes
        dict

    ###
    @description Parses HTML using DOMParser or JSDOM and returns the body element
    @param {string} html - HTML to be parsed
    ###
    parseDom = (html) ->
        if typeof DOMParser isnt 'undefined'
            dom = new DOMParser().parseFromString(html, 'text/html')
            return dom.body
        else
            { JSDOM } = require 'jsdom'
            dom = new JSDOM(html)
            return dom.window.document.body

    cursorRow   = 0
    cursorCol   = 0
    maxRows     = 35
    maxCols     = 80

    ###
    @description Adds a new line at the end of the viewport
    @param {Element} node - DOM node to read metadata from
    @returns {Array} Removed lines if the viewport is full
    ###
    newLine: (node) ->
        cursorCol = 0
        cursorRow++
        if cursorRow >= maxRows
            cursorRow--
            @shift()

    clearScreen: ->
        cursorRow = 0
        cursorCol = 0
        @splice 0, @length

    row: (type = '', properties = {}, columns = []) ->
        type: type
        properties: properties
        columns: columns

    addHTML: (html) ->
        children = (parseDom html).childNodes

        removed = []
        # this could be <span class="line" or <span class="ansi-fg-47">abc</span>
        children.forEach (child) =>
            removed.push ...x if x = @add child

        rowsToHtml removed

    add: (node) ->
        removed = []

        if node.classList.contains 'line'
            @[cursorRow] = @row() if not @[cursorRow]
            @[cursorRow].type = node.tagName.toLowerCase()
            @[cursorRow].properties = attrToDict node

            node.childNodes.forEach (child) =>
                removed.push ...x if x = @add child

            return removed

        @[cursorRow] = @row node.parentNode.tagName, attrToDict node.parentNode, [] if not @[cursorRow]

        #TODO: we should make a generic ansi class and put the command and details in data
        #EX: <span class="ansi" data-command="clearLine"></span>
        #EX: <span class="ansi" data-command="cursorPosition" data-row="1" data=column="2"></span>
        switch
            when node.classList.contains 'ansi-clearLine'
                #@[cursorRow] = @row()
                @[cursorRow].columns = []
                cursorCol = 0
            when node.classList.contains 'ansi-cursorPosition'
                cursorRow = node.dataset.row
                cursorCol = node.dataset.column
            when node.classList.contains 'ansi-clearScreen'
                cursorRow = 0
                cursorCol = 0
                removed = @splice 0, @length
            when node.classList.contains 'cursor-back'
                true

            when node.textContent
                for ch in node.textContent
                    if ch == '\b'
                        if cursorCol == @[cursorRow].columns.length
                            @[cursorRow].columns.length-- if cursorCol > 0
                        else
                            @[cursorRow].columns[cursorCol - 1] = undefined if cursorCol > 0

                        cursorCol-- if cursorCol > 0
                    else
                        @[cursorRow] = @row node.parentNode.tagName, attrToDict node.parentNode, [] if not @[cursorRow]
                        @[cursorRow].columns[cursorCol++] =
                            value: ch
                            type: node.tagName.toLowerCase()
                            properties: attrToDict node

                        removed.push x if ch == '\n' and x = @newLine node

        return removed

    toHTML: ->
        rowsToHtml @

    wrapUrlsInText = (text) ->
        urlRegex = /(https?:\/\/[^\s]+|www\.[^\s]+?\.[a-zA-Z]{2,})/g
        text.replace urlRegex, (match, p1) ->
            url = if p1.startsWith('www.') then "http://#{p1}" else p1
            "<a href=\"#{url}\" target=\"_blank\">#{p1}</a>"

    rowsToHtml = (rows) ->
        html = ''
        for row, rowi in rows
            propString = Object.entries(row.properties).map(([key, value]) -> "#{key}=\"#{value}\"").join(' ')
            if rowi == 0 or JSON.stringify(row.properties) != JSON.stringify(rows[rowi-1].properties)
                html += "<#{row.type}#{if propString then ' ' + propString else ''}>"
            prevType = null
            prevProperties = null
            chunk = ''

            for cell, celli in row.columns
                if not cell or prevType == cell?.type && JSON.stringify(prevProperties) == JSON.stringify(cell?.properties)
                    chunk += if cell then cell.value else ' '
                else
                    if prevType || prevType == null
                        propString = if prevProperties then Object.entries(prevProperties).map(([key, value]) -> "#{key}=\"#{value}\"").join(' ') else ''
                        if chunk
                            newRow = "<#{prevType || 'span'}#{if propString then ' ' + propString else ''}>#{wrapUrlsInText chunk}</#{prevType || 'span'}>"
                            html += newRow
                        chunk = if cell then cell.value else ' '
                        prevType = cell?.type
                        prevProperties = cell?.properties

            if prevType
                propString = Object.entries(prevProperties).map(([key, value]) -> "#{key}=\"#{value}\"").join(' ')
                html += "<#{prevType}#{if propString then ' ' + propString else ''}>#{wrapUrlsInText chunk}</#{prevType}>"

            if row != rows[rows.length-1] and row.columns[row.columns.length - 1]?.value != '\n'
                html += "<span class=\"newLine\">\n</span>"
            if rowi == rows.length-1 or JSON.stringify(row.properties) != JSON.stringify(rows[rowi+1].properties)
                html += "</#{row.type}>"
        html

module.exports = Viewport