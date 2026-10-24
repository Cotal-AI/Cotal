---
"@cotal-ai/cli": patch
---

`up` no longer says a space was forgotten when it names a saved service that was added in this
folder. The receipt still lists every saved service it does not start, and names only those a space
forgotten under the same name left from another folder as inherited, with
`cotal service remove <name> --space <space> --yes`. `--json` carries them as
`result.inheritedServices`.
