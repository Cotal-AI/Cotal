---
"@cotal-ai/core": minor
"@cotal-ai/auth": minor
"@cotal-ai/workspace": minor
"@cotal-ai/cli": minor
---

`cotal chat` opens a session under one stable name that agents can mention, with no random suffix. Without `--name`, it takes the new `name` preference (`cotal config set name <name>`), else your account name on a user-auth space, else your OS login on an open or static space. `cotal login` now records the account name the IdP gives, and `userStatus` returns it as `login.name`. A user-auth sign-in made by an older cotal has no name on record, so `cotal chat` refuses until you sign in again or save a name. The workspace exports `resolveChatName`, `chatNameProblem`, `nameInUse` and `nameInUseText`, and a second session under a name in use is warned with both ways to change it.
