---
"@cotal-ai/connector-core": patch
---

Always answer an authenticated control-plane client, whether or not anyone observes delivery.

The reply write sat inside an optional call's argument list:

```ts
opts.onReply?.(ev, await writeReply(sock, reply, awaitHandoff));
```

Optional chaining short-circuits the entire call expression when the callback is absent, arguments
included, so `writeReply` was never evaluated for any caller that does not pass `onReply`. The
handler still ran and still saw the event; only the client saw the silence, then timed out. Of the
five callers of `startControlServer`, only the Claude Code adapter passes `onReply`, so the opencode
and hermes hook relays got no reply to any control frame, and the pi and codex adapters lost the
error reply they answer non-shutdown ops with. Cooperative shutdown was unaffected: it is acked on a
separate synchronous path.

Writing the reply is the server's job; `onReply` only watches it. The write is now performed first
and its verdict passed to the callback, so the two are no longer coupled.

Covered by a new broker-free suite, `smoke:control-reply`, which drives each of the four production
opts shapes and asserts the reply arrives. Mutation-proved by restoring the short-circuit, which
reddens the no-callback cases while the "handler ran" cell still passes, which is precisely the
asymmetry that made this invisible from the server side.

The one suite that did catch it, `smoke:windows`, is Windows-only, and its red had been merged past
repeatedly. The new suite runs on POSIX and is in `smoke:ci`.
