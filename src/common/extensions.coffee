String::stripAnsi = -> this.toString().replaceAll /\u001B\[[0-9]*(?:;[0-9]+)*[a-zA-Z]{1}/g, ''
String::containsAnsi = -> /\u001B\[[0-9]*(?:;[0-9]+)*[a-zA-Z]{1}/g.test this
String::startsWith = (begin) -> @.indexOf begin is 0
String::getSubsets = (n=0) -> this.slice(0, n) + this.slice(n, n+i+1) for i in [0...this.length-n]
String::word = (n) -> @.split(' ')[n] ? undefined if @.length > 0
String::trimCommand = ->
  return '\n' if @.trim() is '' and @.includes('\n')
  @.trim()

Array::sameValues = (array2) -> this.length is array2.length and this.every (value, index) -> value is array2[index]
Array::filterUntilMatch = (values) ->
	while @.length > 0
		item = @.shift()

		for value in values
			return item if typeof(value) is 'string' and item.word(0) is value
			return item if typeof(value) is 'function' and value(item)
Array::nextMatch = (values) ->
	for i in [0...@.length]
		item = this[i]

		for value in values
			return item if typeof(value) is 'string' and item.word(0) is value
			return item if typeof(value) is 'function' and value(item)

Array::toIndexString = -> "#{index}: '#{value}'" for value, index in @
Array::is = (arr) -> this.length == arr.length and this.every (item) -> item in arr

Object::nameOf = (num) -> key for key, value of this when value is num

Date.constructor.prototype.formatNow = ->
	now = new Date()
	"#{now.getFullYear()}-#{("0" + (now.getMonth() + 1)).slice(-2)}-#{("0" + now.getDate()).slice(-2)} #{("0" + now.getHours()).slice(-2)}:#{("0" + now.getMinutes()).slice(-2)}"

String::isInRange = (range) ->
  return true if @ is range
  return false if not /^\d+$/.test @
  [start, end] = range.split '-'.map (n) -> parseInt(n)
  return start <= @ <= end