---
"@cotal-ai/runtime": patch
"cotal-ai": patch
---

A hosted `cotal run` command whose `--on` names none of the space's running managers is now refused
`TARGET_NOT_FOUND` at once, naming the pin and the managers that run, with nothing sent. It used to
wait out the ten-second describe deadline and then refuse `TARGET_UNAVAILABLE`, saying the registered
manager did not answer on the versioned rail.
