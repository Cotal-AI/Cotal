---
"@cotal-ai/connector-claude-code": patch
"@cotal-ai/connector-core": patch
---

Fix two defects that each, independently, left the AG-UI event plane permanently silent.

The lifecycle hooks were declared with a split `command`/`args` shape the host schema does not
have, so the host ran `node` with no script and every hook silently never fired — taking presence,
peer-message surfacing and the emitter's lazy start with it. The manifest now uses the single-string
command form, with the interpolated plugin root quoted so paths containing a space still work. The
plugin directory is also passed on both launch shapes; it was missing from the `--prompt` shape,
which is how hosted agents start.

Separately, the emitter set itself up before the endpoint had bound. With `--prompt` the first hook
beats the first bind, the holder failed terminally, and one line of stderr was the only trace for
the rest of the session. The emitter now awaits a bounded `whenConnected()` before setup, and that
wait fails past its window rather than resolving as if connected.
