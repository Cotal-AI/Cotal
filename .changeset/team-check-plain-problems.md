---
"@cotal-ai/cli": patch
---

`team check`, `team boot` and `team deploy` refuse a manifest file that does not exist with
`TARGET_NOT_FOUND`, exit 2, naming its path. A missing required key, an empty file, a value of the wrong
shape and one outside a key's fixed values now get a plain reason in place of the validator's text. A persona file that does not
exist is named at its entry's line with the manifest's other problems, where an earlier problem used
to hide it.
