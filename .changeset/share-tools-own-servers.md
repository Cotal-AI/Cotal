---
"@cotal-ai/core": patch
---

`--share-tools` and a roster `share-tools:` list now accept only servers the cotal config declares. A name inherited by every JavaScript object, such as `toString`, `constructor` or `__proto__`, is refused like any other undeclared name, where it used to launch the agent with that server silently missing. A server the config does declare under the name `__proto__` is shared when selected instead of being dropped.
