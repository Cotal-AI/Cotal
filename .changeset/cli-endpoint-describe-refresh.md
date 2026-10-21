---
"@cotal-ai/cli": minor
---

`cotal endpoint describe --refresh` refuses as unsupported and sends nothing. The CLI keeps no resolved contract between calls, so every describe already resolves and fetches the contracts again and there is no cache for the flag to bypass. The usage lines of `cotal spawn` and `cotal status` write their optional names as `[<persona>]` and `[<agent>]`.

Breaking: `endpoint describe --refresh` exits with `UNSUPPORTED` instead of running a plain describe. Drop the flag.
