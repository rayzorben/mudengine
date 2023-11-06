class Observable
  constructor: ->
    observed = new Proxy @,
      set: (target, key, value) =>
        if typeof target[key] isnt 'function' and target[key] isnt value
          @propertyChanged(key, value, target[key]) unless @suppress
          target[key] = value
        true
    Object.assign(observed, @)
    return observed

  propertyChanged: (key, newValue, oldValue) ->

module.exports = Observable