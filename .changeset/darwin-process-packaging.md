---
"@cotal-ai/workspace": patch
---

A packed or published `@cotal-ai/workspace` now carries the macOS process identity binding for
x64 and arm64 beside the Windows pair. Its prepack refuses unless all four bindings are present and
match the committed source and their build receipts. The release builds the macOS pair natively on
Intel and Apple silicon runners and assembles it with the Windows pair, so an upgrade on a Mac never
arrives without the binding that its process pins depend on.
