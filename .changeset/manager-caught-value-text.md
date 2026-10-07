---
"@cotal-ai/manager": patch
---

The manager no longer ends when a runtime, store or extension rejects with `null` or `undefined`. Its catch handlers read `.message` off the caught value, so a runtime whose `waitForExit` rejected `null` after a `stop` ended the manager with an unhandled `Cannot read properties of null (reading 'message')`, a detached deprovision did the same, and a runtime whose `stop` threw `null` turned the stop reply into that `TypeError`. Every log line, refusal and recorded failure in the manager now takes its text from the caught value's `message`, or the value itself when it has none, and falls back to `an unreadable rejection`. A thrown value that cannot be tested as a lifecycle envelope no longer leaves a spawn-as-action goal or a turn accept without its terminal.
