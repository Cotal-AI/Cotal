---
"@cotal-ai/auth": minor
---

Serve several spaces from one auth callout process. `cotal auth-service --callout-only --spaces <manifest>` holds one callout lane per space the manifest names, so a host runs one callout process instead of one per space. A lane holds its own connections, its own connect-limit buckets and its own signing material, and the broker's account isolation decides which lane sees a request, so one space's key never signs another space's response.

The host serves every space in the manifest or none, and names the space it could not serve. It rereads the manifest when it changes on disk, on `SIGHUP`, and on a backstop interval, opening or closing the difference; a manifest that does not read or parse whole is reported and the open lanes are kept. A lane that loses its store connection or the broker closes on its own, the other lanes keep answering, and the host retries that lane every 5 seconds.

`--space` and `--spaces` are alternatives: naming both refuses, and `--spaces` without `--callout-only` refuses. Single-space `--callout-only` is unchanged. Every auth callout journal line now carries `space=<space>`, single-space mode included, so one format covers both.
