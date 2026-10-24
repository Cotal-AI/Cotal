---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

A credential file that does not exist now refuses `TARGET_NOT_FOUND` and names the file, in the
message and the JSON target, wherever a command checks a credential file it is given, such as
`auth revoke-credential <file>` and `auth mint --identity <file>`. A path that cannot be checked
refuses `DEPENDENCY_UNAVAILABLE` and names the file and the cause. Before, both gave one pathless
"missing or unreadable" refusal. A credential file another account can read now has `chmod 600` on
it as its Next, or a private copy when another account owns it. `auth revoke-credential` given a
word that is not a user public key and names no file says both.
