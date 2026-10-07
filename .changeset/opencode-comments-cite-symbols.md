---
"@cotal-ai/connector-opencode": patch
---

Comments in the OpenCode connector name the code they point at by symbol instead of by line number. Three of those line numbers had drifted onto unrelated code, so the 2.x session handshake comment and the turn-wedge stop cell's rationale sent a reader to the wrong place. They now cite `sessionReady` in plugin.ts, `clearErrorRetry` in `quiesce`, the `stopping` refusal in `drive`, `buildLaunch` in extension.ts and `modelReady` in plugin2.ts. No behavior changes.
