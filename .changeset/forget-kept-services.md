---
"@cotal-ai/cli": patch
---

`cotal space forget` now names the services it keeps under the space's name, such as ones
`cotal service add` saved, which a later space with the same name inherits. Its `--json` result
carries them as `keptServices`, and the receipt names the `cotal service remove` that forgets one in
that later space. `cotal up` names each saved service of the space that it does not start, and
`--json` carries them as `result.savedServices`.
