# MudEngine
This is a work in progress. This is intended for developers but anyone can play with it.

Please report any issues.

For now, in order to run make sure you have node/npm installed then

1. clone the repo `git clone https://github.com/rayzorben/mudengine.git`
1. install dependencies `npm install`
1. rebuild better-sqlite3 especially needed if switching from windows/linux or vice-versa `npx electron-rebuild`
1. modify src/config/user.json with username/password/bbs details
1. run with `npm start`

Pull requests are welcome. When making a pull request, include a description on what you added/changed and how to test. For example:

```
Fixed issue when parsing elite guardsman.
Goto Room 1, 234 and search around for elite guardsman.
What happened: game would crash
Whats new: elite guardsman is now parsed and shows in mobs list
``````

CTRL+SHIFT+P is your command center for executing commands for now. Try it.
Example:

CTRL+SHIFT+P
"show rou"
1, 297