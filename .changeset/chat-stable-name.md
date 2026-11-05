---
"@cotal-ai/core": minor
"@cotal-ai/auth": minor
"@cotal-ai/workspace": minor
"@cotal-ai/cli": minor
---

`cotal chat` opens a session under one stable name that agents can mention, with no random suffix. Without `--name`, it takes the new `name` preference (`cotal config set name <name>`), else your handle on a user-auth space, else your OS login on an open or static space. Every chat name is 1 to 128 letters, digits, `_`, `.` or `-`, starting and ending with a letter, digit or `_`, so an `@name` reaches it. Breaking: `--name` no longer accepts a name outside that rule, such as one with a space or an `@`. `cotal login` now records a handle, the IdP's preferred user name, else its email's local part, else its name, the first that is a valid chat name, and `userStatus` returns it as `login.name`. The email is never the handle, so it does not appear in the roster. A user-auth sign-in made by an older cotal, or one whose IdP gives no valid chat name, has no handle on record, so `cotal chat` refuses with `AUTH_REQUIRED` until you sign in again or save a name. Once a `name` preference is saved, an older cotal refuses every preferences read with `defaults has an unknown key "name"` until it is upgraded or this version removes the name with `cotal config unset name`. The workspace exports `resolveChatName`, `chatNameProblem`, `nameInUse` and `nameInUseText`, and a second session under a name in use is warned with both ways to change it.
