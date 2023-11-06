alignments =
    Saint: 'Saint'
    Good: 'Good'
    Neutral: 'Neutral'
    Seedy: 'Seedy'
    Outlaw: 'Outlaw'
    Criminal: 'Criminal'
    Villain: 'Villain'
    FIEND: 'FIEND'
    toString: (value) -> return value
    fromString: (value) ->
        return @Neutral if not value
        key = (k for k, v of @ when v is value)[0]
        key
    getUniqueAlignments: ->
        Object.keys(this).filter (key) => typeof @[key] is 'string'
            .map (key) => @[key]

module.exports = alignments