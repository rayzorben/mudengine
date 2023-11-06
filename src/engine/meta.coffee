meta = (property, list=false) ->
    if list
        (value, target) ->
            if target.prototype[property]
                target.prototype[property] = [ ...target.prototype[property], ...value ]
            else
                target.prototype[property] = value
            target
    else
        (value, target) -> target.prototype[property] = value; target

module.exports = meta