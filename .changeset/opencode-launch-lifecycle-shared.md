---
"@cotal-ai/connector-opencode": patch
---

The OpenCode launcher's lifecycle now lives in `launch`, bundled as `dist/launch.js`, which takes the argv of the TUI to attach and, optionally, extra env for the server, built only once no seat of that name is running. `dist/serve.js` runs it with the `opencode` TUI, as before. The frontier-faces example ran a hand-kept copy of this lifecycle with its face viewer, and the copy had drifted: a face seat kept running after its server exited, refused to start over a `serve.pid` whose pid an unrelated process had reused, and passed the server password on the viewer's argv. It now calls `launch` with the face viewer, which reads the password from `OPENCODE_SERVER_PASSWORD`, and composes its persona file in that env step, so a refused second launch leaves the running seat's persona untouched.
