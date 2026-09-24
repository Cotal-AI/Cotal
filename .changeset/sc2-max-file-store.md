---
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

`cotal up --max-file-store <bytes>` sets the broker's JetStream file storage cap. Before, the rendered broker config carried only `store_dir`, so nats-server always sized its store at start as three quarters of the free disk and an operator on a shared disk had no supported way to bound it. `serverConfig` and `openServerConfig` take an optional `maxFileStore` byte count and render `max_file_store` inside the `jetstream{}` block; left unset, the rendered config is byte-identical to before, and a zero, negative or non-integer value throws naming the option. The cap is recorded on the mesh entry, carried through `down --preserve-state` into the resume, and rendered again by the bare `cotal up` that resumes it. A resume or a refresh of a running mesh that asks for a different cap is refused, because nats-server fixes the cap at start and refuses a reload that changes it. The flag is refused with `-f`. Fixes #1888.
