---
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

A file saved as UTF-16, as Windows PowerShell 5.1 writes by default, is now refused by its encoding,
with the step to save it as UTF-8. That covers a persona file in the catalog, in `persona show` and in
`persona create --file`, a team manifest, a `.cotal/channels.json` or `--channels` file, and
`preferences.json`. Before, each reported a generic invalid definition, schema shape or JSON error,
with no word about the encoding.
