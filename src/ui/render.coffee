{ ipcRenderer, clipboard } = require 'electron'
commandBar = require './commandBar.coffee'

extensions = require '../common/extensions.coffee'
options    = require '../config/options.coffee'
Viewport   = require './viewport.coffee'

viewport = new Viewport()

mudengine    = document.getElementById "console"
current      = document.getElementById "viewport"
history      = document.getElementById "history"
report       = document.getElementById "report"
statusNav    = document.getElementById "navigation"
statusMsg    = document.getElementById "message"
statusRate   = document.getElementById "rate"
notification = document.querySelector "#notification"

mudengine.focus()

userScrolling = false
timeout       = null
isRendering   = false
showStatus    = false

userConfig    = undefined

ipcRenderer.on 'user-config', (event, data) -> userConfig = data

###
KEYBOARD ROUTINES
###
suppressKeys = [ 'ArrowUp', 'ArrowDown', 'ArrowRight', 'ArrowLeft' ]

mudengine.tabIndex = 0
mudengine.focus()

mudengine.addEventListener 'keydown', (e) ->
  e.preventDefault() if e.key in suppressKeys
  modifiers = []
  modifiers.push 'Control' if e.ctrlKey and 'Control' not in modifiers
  modifiers.push 'Meta' if e.metaKey and 'Meta' not in modifiers
  modifiers.push 'Alt' if e.altKey and 'Alt' not in modifiers

  keyChord = "#{modifiers.join('+')}#{if e.shiftKey then '+Shift' else ''}+#{e.key}"

  switch keyChord
    when "Control+Shift+P" then commandBar()
    when "Control+v" then ipcRenderer.send 'keyboard-input', clipboard.readText(), true
    else ipcRenderer.send 'keyboard-input', e.key if modifiers.length is 0

###
SEARCHING COMMANDS
###
###
SCROLLING
###
mudengine.addEventListener 'scroll', ->
	clearTimeout timeout

	timeout = setTimeout ->
		userScrolling = mudengine.scrollTop + mudengine.clientHeight < mudengine.scrollHeight - 1
	, 100

###
RENDERING
###
removeCursor = -> current.querySelectorAll("#cursor").forEach (e) -> e.parentNode.removeChild e
renderCursor = -> current.insertAdjacentHTML 'beforeEnd', '<span id="cursor"></span>'

render = (change) ->
	return change() if isRendering

	isRendering = true

	try
		removeCursor()
		change()
		renderCursor()

		mudengine.scrollTop = mudengine.scrollHeight unless userScrolling
	finally
		isRendering = false

ignoreBlocks = ['StatusLine', 'UserCommand']
#ignoreBlocks = []

ipcRenderer.on 'mudblock', (event, data) ->
	#console.log util.inspect data, depth: 0, colors: true if data.block not in ignoreBlocks or showStatus
    addToViewport data.html
    ipcRenderer.send 'request-user-data'

addToViewport = (data) ->
	render ->
		removed = viewport.addHTML data
		appendToHistory removed if removed
		current.innerHTML = viewport.toHTML()

		# remove old entries from history that go beyond maxHistoryLines
		history.firstChild.remove() while history.childElementCount > options.ui.maxHistoryLines
		applyCSS userConfig.customStylesheet if userConfig

appendToHistory = (htmlString) ->
	# Convert string to HTMLElement
	tempDiv = document.createElement('div')
	tempDiv.innerHTML = htmlString

	lastChild = history.lastElementChild

	hasSameProperties = (el1, el2) ->
		return false if el1?.attributes?.length != el2?.attributes?.length

		for i in [0...el1.attributes.length]
			return false if el1.attributes[i].name != el2.attributes[i].name or el1.attributes[i].value != el2.attributes[i].value

		return true

	Array.from(tempDiv.children).forEach (newElement) ->
		# append to last child
		if lastChild and hasSameProperties(lastChild, newElement)
			for child in Array.from(newElement.children)
				lastChild.appendChild(child)
		else
			history.appendChild(newElement)

ipcRenderer.on 'user-data', (event, data) -> renderJSON data, report, report.innerHTML isnt ""
ipcRenderer.on 'viewport-print', (event, data) -> addToViewport data
ipcRenderer.on 'status-navigation', (event, data) ->

applyCSS = (cssObj) ->
  for selector, styles of cssObj
    elements = document.querySelectorAll(selector)
    for el in elements
      for key, value of styles
        el.style[key] = value

setInterval ->
	notifications = document.getElementsByClassName "notify"

	Array.from(notifications).forEach (element) ->
		ts = element.querySelector("#timestamp").innerText
		removalTime = switch
			when element.classList.contains("ok") then 3
			when element.classList.contains("info") then 10
			when element.classList.contains("warn") then 60
			when element.classList.contains("alert") then 300
			else 0

		if Math.abs((Date.now() - ts) / 1000) >= removalTime
			element.parentNode.removeChild element
, 10000

debug = ->
	notifications = document.getElementById 'notification-box'
	alert = """
	          <div class="ok notify">
	          <span class="closebtn" onclick="this.parentElement.parentElement.removeChild(this.parentElement);">&times;</span>
	          #{data}
	          <span id="timestamp" style="display:none">#{Date.now().toString()}</span>
	          </div>
	        """
	notifications.insertAdjacentHTML 'beforeend', alert

generateNotification = (type, event, data) ->
	notifications = document.getElementById 'notification-box'
	alert = """
	          <div class="#{type} notify">
	          <span class="closebtn" onclick="this.parentElement.parentElement.removeChild(this.parentElement);">&times;</span>
	          #{data}
	          <span id="timestamp" style="display:none">#{Date.now().toString()}</span>
	          </div>
	        """
	notifications.insertAdjacentHTML 'beforeend', alert

ipcRenderer.on 'notification-ok', (event, data) ->
	generateNotification "ok", event, data

ipcRenderer.on 'notification-info', (event, data) ->
	generateNotification "info", event, data

ipcRenderer.on 'notification-warn', (event, data) ->
	generateNotification "warn", event, data

ipcRenderer.on 'notification-alert', (event, data) ->
	generateNotification "alert", event, data

###
DYNAMIC UPDATES
###
renderJSON = (data, parent, update = false) ->
	for key of data
		value = data[key]
		continue if typeof value is 'function'
		existingLine = parent.querySelector(".property-row[data-key='#{key}']")

		if existingLine? and update
			#if value is undefined
			if value is undefined or value is null or (typeof value is 'object' and Object.keys(value).length == 0)
				existingLine.lastChild?.innerHTML = ""
				existingLine.classList.remove "expanded"
				continue
			line = existingLine
		else
			continue if data[key] is undefined or data[key] is null
			line = document.createElement("div")
			line.className = "property-row"
			line.setAttribute("data-key", key)
			parent.appendChild(line)

		if Array.isArray(value) or typeof(value) is 'object'
			do (line, value) =>
				if update and line.firstChild?
					collapsible = line.firstChild
					content = line.lastChild
				else
					collapsible = document.createElement("button")
					collapsible.innerText = key
					collapsible.className = "collapsible"
					line.appendChild(collapsible)
					content = document.createElement("div")
					content.className = "content"
					line.appendChild(content)
					collapsible.addEventListener "click", ->
						if content.style.display is "block"
							content.style.display = "none"
							collapsible.classList.remove "expanded"
						else
							content.style.display = "block"
							collapsible.classList.add "expanded"

				if Array.isArray(value)
					content.innerHTML = ""
					if typeof(value[0]) is 'object'
						table = document.createElement('table')
						table.className = 'styled-table'
						header = document.createElement('thead')
						row = document.createElement('tr')

						for field in Object.keys(value[0])
							th = document.createElement('th')
							th.innerText = field
							row.appendChild(th)
						header.appendChild(row)
						table.appendChild(header)

						tbody = document.createElement('tbody')
						for obj in value
							row = document.createElement('tr')
							for field of obj
								continue if typeof obj[field] is 'function'
								td = document.createElement('td')
								td.innerText = obj[field]
								row.appendChild(td)
							tbody.appendChild(row)
						table.appendChild(tbody)
						content.appendChild(table)
					else
						listItem = document.createElement "div"
						listItem.innerText = value.join ", "
						content.appendChild listItem
				else
					renderJSON value, content, update

		else
			if update and line.firstChild? and line.lastChild?
				label = line.firstChild
				input = line.lastChild
				input.value = value
			else
				label = document.createElement("label")
				label.innerText = key
				input = document.createElement("input")
				input.value = value
				line.appendChild(label)
				line.appendChild(input)