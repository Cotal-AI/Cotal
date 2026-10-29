---
"@cotal-ai/paseo": minor
"@cotal-ai/cli": minor
"@cotal-ai/workspace": minor
---

Add the Paseo integration: a new `@cotal-ai/paseo` extension with a self-registering `paseo` Runtime provider that spawns managed agents into Paseo workspace terminals, so they can be watched and steered from the Paseo apps. It finds the local daemon with `paseo daemon status` and drives terminals over one `@getpaseo/client` connection; each terminal runs an owner-only launcher that holds the launch env and credentials, status reads a background terminal census, and exit is proved by the terminal leaving the daemon's list. The CLI lists `paseo` among the official runtimes (`cotal runtimes`, `cotal setup --runtime paseo`, `cotal ext add @cotal-ai/paseo`).
