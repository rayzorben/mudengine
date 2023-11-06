{ ipcRenderer } = require 'electron'

searchBar = document.getElementById('search-bar')
searchInput = document.getElementById('search-input')
commandList = document.getElementById('command-list')
commandInput = document.getElementById('command-input')
mudengine = document.getElementById('console')

recentCommands = []

commands = [
  {command: "Goto Room", action: -> getRoom handlers.gotoRoom},
  {command: "Show Route", action: -> getRoom handlers.showRoute},
  {command: "Stop Route", action: -> handlers.stopRoute()},
  {command: "Loop Area", action: -> handlers.loopArea()},
  {command: "Toggle All On", action: -> handlers.toggleAllOn()},
]

searchBar.onkeyup = (event) ->
	switch event.key
		when 'Escape' then hideSearchBar()
		when 'Enter' then executeSingleFilteredCommand()
		else filterCommands(event.target.value)

getRoom = (action) ->
	searchInput.style.display = 'none'
	commandInput.placeholder = "Enter Map/Room or Name"
	commandInput.value = ''
	commandInput.style.display = 'block'
	commandInput.onkeyup = (event) -> ipcRenderer.send 'query-rooms', event.target.value, action.name

	commandInput.focus()

handlers =
  showRoute: (map, room) -> ipcRenderer.send 'command', 'show-route', "#{map}, #{room}"
  stopRoute: ->
    ipcRenderer.send 'command', 'stop-route'
    hideSearchBar()
  gotoRoom: (map, room) -> ipcRenderer.send 'command', 'goto', "#{map}, #{room}"
  loopArea: -> return
  toggleAllOn: ->
    ipcRenderer.send 'command', 'toggle-all-on'
    hideSearchBar()

ipcRenderer.on 'query-rooms-response', (event, info) ->
	displayList info.rooms,
		(room) -> "#{room.name} (#{room.map}, #{room.room})",
		(room, info) =>
			commandInput.value = "#{room.map}, #{room.room}"
			handlers[info.action](room.map, room.room) if info.action
			hideSearchBar()
		, info

# Function to execute when there's only one command after filtering
executeSingleFilteredCommand = ->
    commandList.firstChild.click() if commandList.childNodes.length == 1

# Popup the search bar
showSearchBar = ->
	searchBar.style.display = 'block'
	commandInput.style.display = 'none'
	searchInput.style.display = 'block'
	searchInput.focus()

# Hide the search bar
hideSearchBar = ->
	searchBar.style.display = 'none'
	searchInput.value = ''
	mudengine.focus()

# Filter the commands based on the input
filterCommands = (inputValue) ->
	filteredCommands = commands.filter (command) ->
		command.command.toLowerCase().includes inputValue.toLowerCase()

	displayList filteredCommands,
		(command) -> command.command,
		(command) ->
			command.action()
			recentCommands.unshift(command)
			recentCommands = recentCommands.slice(0, 5)  # Keep the list to 5 items

displayList = (items, textFunction, clickFunction, args...) ->
    commandList.innerHTML = ''

    for item in items
        ((item) ->
            listItem = document.createElement('li')
            listItem.textContent = textFunction(item, args...)
            listItem.onclick = -> clickFunction(item, args...)
            commandList.appendChild(listItem)
        )(item)

module.exports = showSearchBar