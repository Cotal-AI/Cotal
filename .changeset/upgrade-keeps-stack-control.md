---
"@cotal-ai/cli": patch
---

Keep a controller stack controllable across an upgrade. Each member record pins its built-in
adapter at the release that wrote it, and every control path compared that version too, so after
`npm i -g cotal-ai@<new>` the new `cotal down` refused to stop a running stack (CONFLICT, "the
selected native service pins another definition or adapter revision") and `cotal up` refused to
restart a stopped one. Built-in and first-party adapters are version-locked to the CLI, so their pins
now match on name, package and declaration; a third-party adapter's version still counts. Also list
the candidate IDs of an ambiguous service instance on one line, instead of printing `\u000a`
between them.
