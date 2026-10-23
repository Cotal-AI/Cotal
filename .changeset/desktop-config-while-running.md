---
"@cotal-ai/connector-claude-code": patch
---

On macOS, `cotal setup` and `cotal update` no longer write Cotal's entry into Claude Desktop's
`claude_desktop_config.json` while Claude Desktop is running. Desktop reads that file when it starts
and writes the copy it holds back on ordinary use, such as switching a Code session or changing the
model, so an entry added while it ran was dropped. Setup now finishes its other steps and reports
that the Desktop entry was not added, with the fix: quit Claude Desktop, then run `cotal setup`
again from a terminal outside it. Windows is unchanged.
