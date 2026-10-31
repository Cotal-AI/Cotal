---
"cotal-ai": patch
---

On Node 24, a `cotal` command could print its result and then never exit. This came from a Node bug (nodejs/node#64274): `process.exit()` waits for V8's background compiler threads, and a Maglev or background Sparkplug compile waiting for a garbage collection never finishes. The CLI entry now turns Maglev and background Sparkplug off before anything else loads, as Node 22 does by default. This covers every command and every daemon the binary starts.
