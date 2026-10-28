---
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-claude-code": minor
"@cotal-ai/connector-codex": minor
"@cotal-ai/connector-hermes": minor
"@cotal-ai/connector-jcode": minor
"@cotal-ai/connector-opencode": minor
"@cotal-ai/pi": minor
"@cotal-ai/cli": minor
"cotal-ai": minor
---

Cut what an idle seat costs its host, with stock build and runtime mechanisms.

Every connector bundle that loads into a long-running process now ships as one-byte text. V8 holds a
string at one byte per character only while every character is Latin-1, and a single character above
U+00FF made each 5 MB bundle two-byte for the life of the process. The characters were em dashes and
arrows in comments, so the bundles are built with esbuild's `--minify-whitespace`, which drops
comments and the parentheses around a single arrow parameter, and keeps every identifier. Anything
matching text in a built bundle sees the second part: `(e) => f(e)` now reads `e=>f(e)`. `pnpm smoke:connector-bundle-text` reads the 19 built bundles
and fails on any character above U+00FF. Stack-trace frames keep their function names and their line
and column numbers move, because the bundle is now fewer, longer lines.

The Claude Code connector's seat is launched through a new entry, `dist/seat.cjs`, which enables
Node's module compile cache in `~/.cotal/compile-cache` and then loads `dist/mcp.cjs`. Node's cache
covers modules compiled after it is enabled, so the entry has to sit in front of the bundle. The
directory is created 0700 like the rest of `~/.cotal`, whatever the launching umask was. A cache
that cannot be opened prints one line and the seat serves without it,
`NODE_DISABLE_COMPILE_CACHE=1` turns it off, and `NODE_COMPILE_CACHE` takes precedence and is left
alone. `dist/mcp.cjs` remains the library entry (`@cotal-ai/connector-claude-code/mcp`) and still
serves when run directly.

The declared Node floor rises from 22 to 22.10, which is where `module.flushCompileCache()` lands,
and every package's `engines.node` now says so. The `cotal` binary checks it at its front door and
refuses an older runtime with the floor, the running version and the repair for how it was
installed; the seat entry refuses before its first cache call, so an old Node gets one sentence
rather than a `TypeError`; and the installer compares the minor version, so a host whose own Node is
22.9 gets the pinned Node downloaded and verified instead. `node dist/mcp.cjs` still serves on an
older runtime. Operators moving a host read
[the upgrade note](https://github.com/Cotal-AI/Cotal/blob/main/docs/UPGRADING.md).

Measured on one idle seat per arm, Node v22.23.2, paired and read at 160 s and 600 s: 41.9 MiB USS
on the stock bundle, 35.2 with one-byte text, 26.3 with the seat entry's compile cache as well.
