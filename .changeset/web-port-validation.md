---
"@cotal-ai/web": patch
---

`cotal web` now refuses a `--port` that is not a decimal number from 1 to 65535 before it connects to the broker or claims the dashboard pidfile, with an error that names `--port`. `--port 0` used to bind an ephemeral port while the printed link, the recorded launch link and the console's allowed Origin all named port 0, and a detached launch probed port 0 until it timed out. A hex or exponent spelling such as `0x1f90` was accepted, and `abc` or `70000` failed only after connecting, with `Invalid URL`. An empty `--port` no longer falls back to 7799.
