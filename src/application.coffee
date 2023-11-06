{ app, BrowserWindow, ipcMain } = require 'electron'

path = require('path')
User = require('./engine/user')
{ db, rooms: db.rooms } = require './engine/data.coffee'

mainWindow = undefined

createWindow = ->
    mainWindow = new BrowserWindow(
        width: 1280
        height: 1024
        webPreferences:
            nodeIntegration: true
            contextIsolation: false
            enableRemoteModule: true
    )
    mainWindow.loadFile path.join(__dirname, 'index.html')

app.on 'ready', -> createWindow()
app.on 'window-all-closed', ->
	app.quit() unless process.platform == 'darwin'
app.on 'activate', ->
	createWindow() if BrowserWindow.getAllWindows.length == 0

app.whenReady () ->
.then () ->
	mainWindow.webContents.openDevTools()
	mainWindow.maximize()
	mainWindow.webContents.on 'did-finish-load', -> init()

init = ->
    user = new User

	###
	PROXY EVENTS
	###
    user.on 'user-config', (config) -> mainWindow?.webContents.send 'user-config', config
    user.on 'block', (json) -> mainWindow?.webContents.send 'mudblock', json
    user.on 'notify-ok', (message) -> mainWindow?.webContents.send 'notification-ok', message
    user.on 'notify-info', (message) -> mainWindow?.webContents.send 'notification-info', message
    user.on 'notify-warn', (message) -> mainWindow?.webContents.send 'notification-warn', message
    user.on 'notify-alert', (message) -> mainWindow?.webContents.send 'notification-alert', message
    user.on 'viewport-print', (message) -> mainWindow?.webContents.send 'viewport-print', message

    user.load path.resolve(__dirname, './config/user.json')
    user.connect()

    ipcMain.on 'request-user-data', (event) -> mainWindow?.webContents.send 'user-data', user.output()
    ipcMain.on 'command', (event, command, data) ->
        switch command
            when 'goto' then user.goto ...data.split(/\D+/).filter(Boolean)
            when 'show-route' then user.printRouteTo data
            when 'stop-route' then user.stopRoute()
            when 'toggle-all-on' then user.toggleAllOn()

    ipcMain.on 'query-rooms', (event, match, target) ->
        [ map, room ] = match.split(/\D+/).filter(Boolean)
        rooms = db.rooms.byLocation map, room
        rooms = db.rooms.byNameLike "%#{match}%" if rooms.length is 0

        return unless rooms and rooms.length > 0
        response =
            rooms: rooms.map (room) ->
                name: room.Name
                map: room.Map
                room: room.Room
            action: target

        mainWindow?.webContents.send 'query-rooms-response', response

    ipcMain.on 'keyboard-input', (event, message, isString = false) ->
        switch message
            when "Enter" then user.userHitEnter()
            when "Backspace" then user.backspace()
            when "ArrowUp" then user.send "\u001B[A"
            when "ArrowDown" then user.send "\u001B[B"
            when "ArrowRight" then user.send "\u001B[C"
            when "ArrowLeft" then user.send "\u001B[D"
            else user.keyPress message if isString or message.length is 1