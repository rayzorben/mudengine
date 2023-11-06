###
This file is used to customize any events.
###
eventHandler = (user) ->
    ###
    @description This keeps the session alive by sending a command when nothing
    has been sent for a while.
    ###
    user.eventIdleTimeout = undefined

    user.keepAlive = ->
        clearInterval user.eventIdleTimeout if user.eventIdleTimeout
        user.eventIdleTimeout = setInterval ->
            user.idleCommand user.config.idleCommand ? "\n" if user.inRealm() and not user.isTyping()
        , user.options.engine.idleCommandSend * 1000

    user.on 'room-changed', (room) ->
      #user.notify "#{ room.name } entered."
    user.on 'item-on-ground', (item) ->
      #user.notify "found item #{ item.name }"
    user.on 'game-enter', -> return
    #user.on 'room', -> user.debugPrint()

    user.on 'user-command', (text) ->
        result = /^~(?<command>.*)$/.exec text
        user.evalCommand result?.groups.command if result
        user.debugPrint() if /^!$/.test text.trim()
        user.goto 1, 297 if /^!goto$/.test text.trim()

    user.on 'status', (status) -> return
    user.on 'status-line', (hp, ma, type, state) ->
        #user.disconnect() if hp < user.config.health.below
        return

    user.on 'command', (command, source, args) ->
        switch command
            when 'where'  then source.reply "@where{#{ user.currentRoom?.map },#{ user.currentRoom?.room }}"
            when 'eval'   then source.reply "{ #{ user.evalCommand args }}"
            when 'health' then source.reply user.healthstr()

module.exports = eventHandler