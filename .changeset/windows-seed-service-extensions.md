---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

`cotal setup` and `cotal ext seed` work on Windows again. Adding an extension that declares service adapters or presets, such as the web dashboard, read its package metadata through protected file access, which Windows does not have in this release, so the seed refused `UNSUPPORTED` and no connector was set up. On Windows such an extension is now added with no service receipt, `ext add` says that its services cannot run on this platform, and any use of those services refuses `UNSUPPORTED`. Linux and macOS are unchanged.
