# The oa-bus agy plugin (agy S2)

`oa-bus install` copies these files to
`~/.gemini/config/plugins/oa-bus/` and writes `hooks.json` next to them: its
`SessionStart` hook runs this bus's `oa-bus agy-hello`, so the command line
depends on where the bus is installed. `oa-bus uninstall` removes only these
files, `hooks.json` and the `.oa-bus-managed` marker. The bundle copies this
folder to `assets/agy-plugin/`.
