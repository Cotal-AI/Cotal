---
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-claude-code": minor
"@cotal-ai/connector-codex": minor
"@cotal-ai/connector-hermes": minor
"@cotal-ai/connector-jcode": minor
"@cotal-ai/connector-opencode": minor
"@cotal-ai/pi": minor
---

Cut what an idle seat costs its host, with stock build and runtime mechanisms.

Every connector bundle that loads into a long-running process now ships as one-byte text. V8 holds a
string at one byte per character only while every character is Latin-1, and a single character above
U+00FF made each 5 MB bundle two-byte for the life of the process. The characters were em dashes and
arrows in comments, so the bundles are built with esbuild's `--minify-whitespace`, which drops
comments and keeps every identifier. `pnpm smoke:connector-bundle-text` reads the 19 built bundles
and fails on any character above U+00FF. Stack-trace frames keep their function names and their line
and column numbers move, because the bundle is now fewer, longer lines.

The Claude Code connector's seat is launched through a new entry, `dist/seat.cjs`, which enables
Node's module compile cache in `~/.cotal/compile-cache` and then loads `dist/mcp.cjs`. Node's cache
covers modules compiled after it is enabled, so the entry has to sit in front of the bundle. A cache
that cannot be opened prints one line and the seat serves without it, and
`NODE_DISABLE_COMPILE_CACHE=1` turns it off. `dist/mcp.cjs` remains the library entry
(`@cotal-ai/connector-claude-code/mcp`) and still serves when run directly.

Measured on one idle seat per arm, Node v22.23.2, paired and read at 160 s and 600 s: 41.9 MiB USS
on the stock bundle, 35.2 with one-byte text, 26.3 with the seat entry's compile cache as well.
