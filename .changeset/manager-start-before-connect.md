---
"cotal-ai": patch
"@cotal-ai/auth": patch
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
"@cotal-ai/workspace": patch
---

`cotal manager start` on a user-auth space with no sign-in no longer launches a manager it cannot confirm. On a space the folder hosts, `manager start` and `manager restart` without a signed-in, granted login refuse `AUTH_REQUIRED` (exit 2) under a `Mesh: <space>` heading before anything is saved or launched, and Next names `cotal login`, then the command again. A manager left running without a sign-in stops: in the folder that hosts the space, `cotal manager stop` and `cotal down` read the manager's stop impact from its own local receipt, so the folder's owner needs no sign-in.

`cotal supervise` refuses before it connects with exit 2, a `Mesh:` heading and a code, and writes nothing in the folder. A space whose own stack in this folder is stopped names `cotal up` there and, with `--server`, the folder whose `cotal up` started that broker. A user-auth space that another folder hosts names the folder that hosts it.

The deprecation notice of `supervise` and the other deprecated daemon entries wraps at the terminal width with each command kept whole. The manager prints its boot inventory once it is up, so a refused start prints no boot line, and the line for no available connector is in plain words.
