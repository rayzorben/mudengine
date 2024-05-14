fs = require 'fs'
yaml = require 'yaml'
path = require 'path'
{ app } = require 'electron'

options = undefined

replacements =
    resources: if app?.isPackaged then process.resourcesPath else path.join __dirname + "/../../resources"
    
configFile = path.join replacements.resources, 'options.yaml'

# Function to load YAML file into a variable
loadYaml = (filePath) ->
    try
        yamlContent = fs.readFileSync(filePath, 'utf8')
        replacedContent = yamlContent.replace /\{(\w+)\}/g, (match, key) ->
            if replacements.hasOwnProperty(key)
                replacements[key]
            else
                match
        options = yaml.parse(replacedContent)
    catch error
        console.error("Error loading config: ", error)
        null

# Watch for changes in the YAML file
watchYamlFile = (filePath, callback) ->
    fs.watch filePath, (event, filename) ->
        if event == 'change'
            console.log("Reloading config file...")
            data = loadYaml filePath
            if data
                callback(data)

options = loadYaml configFile
watchYamlFile configFile, (config) ->
    options = config
    
currentOptions = ->
    options
    
module.exports = currentOptions