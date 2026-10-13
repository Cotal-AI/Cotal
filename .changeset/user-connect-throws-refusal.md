---
"@cotal-ai/workspace": patch
---

`connectOrThrow` and `connectUserControlOrThrow` now throw a user-auth mesh's login and exchange refusals (not logged in, auth service down, actor not granted) as a `ConnectRefusal` carrying the provider's sentence. `connectOrThrow` used to print that sentence and exit the process, so the console's `delchan` on a user mesh with no login on the machine ended the console instead of showing the refusal on its status line. `connectOrExit` and `connectUserControlOrExit` still print the same sentence and exit 1.
