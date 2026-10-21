---
"@cotal-ai/connector-core": patch
"@cotal-ai/cli": patch
---

A direct message to an agent the roster shows offline now says so, and says what happens next: the
message is stored and delivered when that agent reconnects, and a new agent spawned under the same
name does not receive it. `cotal_dm` adds the notice to its answer, `cotal send -t` prints it as a
`RECIPIENT_OFFLINE` warning, `cotal chat` adds it to the view and carries `recipientStatusAtSend` in
its `--stdio` stored result, and `cotal join` and the console print it after the send.
