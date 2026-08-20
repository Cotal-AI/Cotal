---
"@cotal-ai/pi": patch
---

Wrap visible Cotal inbox and tool text by terminal columns instead of JavaScript string length. Emoji and CJK text can occupy two terminal cells per code point; a peer status line containing two check marks was emitted at 122 cells in a 120-column Pi TUI and terminated the process. The Pi adapter now uses the host's canonical ANSI/grapheme-aware wrapper, with a regression fixture from the live crash.
