{ db, rooms: db.rooms } = require './data.coffee'

# Node Class
class Node
    constructor: (@mapNumber, @roomNumber, @details) ->
        @children = {}
        @parents = {}
        @instructions = {}

    addChild: (direction, childNode, instruction) ->
        @children[direction] = childNode
        @instructions[direction] = instruction
        childNode.parents[direction] = this

    getDetail: (key) ->
        @details[key]

# Graph Class
class Graph
    constructor: ->
        @nodes = {}

    addNode: (node) ->
        key = "#{node.mapNumber}/#{node.roomNumber}"
        @nodes[key] = node

    find: (mapNumber, roomNumber) ->
        key = "#{mapNumber}/#{roomNumber}"
        return @nodes[key]

# Helper function to parse direction value
parseDirectionValue = (value) ->
    match = value.match(/(\d+\/\d+)(?:\s*\((.+)\))?/)
    #TODO: 10/3 has an Action#1 on say faith
    return if not match
    return {
        mapRoom: match[1],
        instruction: match[2] || null
    }

#TODO: since these are used by user/rooms we should make one spot
DIRECTIONS = ["N", "S", "E", "W", "U", "D", "NE", "NW", "SE", "SW"]
# Function to create a graph from DB data
createGraphFromDb = (db) ->
    graph = new Graph()

    # First, create all nodes
    for entry in db
        node = new Node(entry["Map Number"], entry["Room Number"], entry)
        graph.addNode(node)

    # Connect nodes based on directions
    for entry in db
        currentNode = graph.find(entry["Map Number"], entry["Room Number"])

        for direction, value of entry when direction in DIRECTIONS
            continue if value is "0"
            parsed = parseDirectionValue(value)
            continue unless parsed
            childNode = graph.find(...parsed.mapRoom.split("/"))
            if childNode?
                currentNode.addChild(direction, childNode, parsed.instruction)

    return graph

calculatePriority = (node, rules) ->
    priority = 0
    for key, ruleSet of rules
        for rule in ruleSet
            detail = node.getDetail(key)
            if detail == rule.value
                priority += rule.priority

    priority

reconstructPath = (cameFrom, endNode) ->
    totalPath = [endNode]
    current = endNode

    while current? and cameFrom.has(current)
        current = cameFrom.get(current)
        totalPath.unshift(current) if current?

    return totalPath

# Heuristic function
getHeuristic = (node, endNode, rules) ->
    # higher cost for higher map numbers
    dx = Math.abs(node.mapNumber - endNode.mapNumber)
    # higher cost for higher room numbers above 10 allows for more direct paths
    dy = Math.abs(node.roomNumber - endNode.roomNumber)
    dy = dy > 10 ? dy : 0
    h = dx + dy
    h + calculatePriority(node, rules)

# A* search algorithm
aStarSearch = (graph, user, startCoords, endCoords, rules) ->
    startNode = graph.find(startCoords[0], startCoords[1])
    endNode = graph.find(endCoords[0], endCoords[1])

    openList = [startNode]
    closedList = new Set()
    cameFrom = new Map()

    gScore = new Map()
    gScore.set(startNode, 0)

    fScore = new Map()
    fScore.set(startNode, getHeuristic(startNode, endNode, rules))

    while openList.length > 0
        current = openList.sort((a, b) -> (fScore.get(a) or Infinity) - (fScore.get(b) or Infinity))[0]

        if current == endNode
            return reconstructPath(cameFrom, endNode)

        openList.splice(openList.indexOf(current), 1)
        closedList.add(current)

        for direction, neighbor of current.children
            if closedList.has(neighbor)
                continue

            instructionResult = evaluateInstructions user, neighbor.instructions?[direction]
            continue if instructionResult is undefined

            tentativeGScore = (gScore.get(current) or 0) + 1

            if openList.indexOf(neighbor) < 0
                openList.push(neighbor)
            else if tentativeGScore >= (gScore.get(neighbor) or Infinity)
                continue

            cameFrom.set(neighbor, current)
            gScore.set(neighbor, tentativeGScore)
            tentativeFScore = tentativeGScore + getHeuristic(neighbor, endNode, rules)
            tentativeFScore += instructionResult if instructionResult
            fScore.set(neighbor, tentativeFScore)

    return []

evaluateInstructions = (user, instruction) ->
    result = /^(Door|Alignment|Text|Key|Level|Item|Toll|Hidden\/Searchable):?\s?(.*)$/.exec(instruction)
    command = result?[1]
    value = result?[2]
    switch command
        when "Toll" then undefined if user.inventory.wealth < value
        when "Door" then -500
        else 0

getNextPath = (path) ->
    currentNode = path[0]
    nextNode = path[1]

    direction = null
    for dir, child of currentNode?.children
        if child == nextNode
            result =
                instructions: currentNode.instructions[dir]
                direction: dir

            result = getInstructionText result
            break

    direction
    
removeNext = -> path.shift()

getInstructionText = (next) ->
    return unless next.instructions
    [all, command, value] = /^(Door|Alignment|Text|Key|Level|Item|Toll|Hidden\/Searchable):?\s?(.*)$/.exec(next.instructions)
    switch command
        when "Text" then next.command = value.split(/,/)[0].trim()
        when "Hidden\/Searchable" then next.search = true
    next

directionsFromPath = (path) ->
    directions = []
    for i in [0...path.length - 1] when i < path.length - 1
        currentNode = path[i]
        nextNode = path[i+1]

        direction = null
        for dir, child of currentNode?.children
            if child == nextNode
                direction = dir
                break

        if direction
            directions.push "#{direction} #{currentNode?.details['Name']} (#{currentNode?.mapNumber}/#{currentNode.roomNumber}) -> #{nextNode?.details['Name']} (#{nextNode.mapNumber}/#{nextNode.roomNumber}) #{if currentNode?.instructions is not null then JSON.stringify(currentNode?.instructions[direction]) else ''}"
        else
            directions.push "No valid direction found from Room #{currentNode?.mapNumber}/#{currentNode?.roomNumber} to Room #{nextNode.mapNumber}/#{nextNode.roomNumber}"

    return directions

pathSearch = (user, start, end, rules) -> aStarSearch graph, user, start, end, rules

graph = createGraphFromDb db.rooms.allRooms()

module.exports =
    search: pathSearch,
    next: getNextPath,
    removePath: removeNext
    route: directionsFromPath