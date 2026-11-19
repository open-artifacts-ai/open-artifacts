# Hermes adapter

The `oa-bus` Hermes plugin. `oa-bus install` copies it to `<hermes home>/plugins/oa-bus` and enables it.

## Waking a chat

A Hermes chat with no turn in progress sees bus mail at its next turn. To have mail start a turn,
turn on `allow_gateway_injection` for the plugin in your Hermes config (the installer never sets it):

```yaml
plugins:
  entries:
    oa-bus:
      allow_gateway_injection: true   # lets bus mail start a turn in the chats you allow; the message text and the agent's reply appear in that chat
      settings:
        wake: ["agent:main:telegram:group:123"]   # extra chats: exact session keys; a platform name also wakes its threads
```

Direct messages with one person wake by default. A group or channel wakes only when its exact session
key is in `wake`; a chat whose type Hermes did not report never wakes. Everything else waits for the
chat's next turn.

A direct message wakes by default, even when the person in it isn't you: they see the message and your agent's reply. A thread is read by everyone in its channel, so list a platform only if that's fine.
