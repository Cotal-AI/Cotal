---
"@cotal-ai/cli": patch
---

`cotal doctor auth` names a credential file that other accounts can open by its mode, with `chmod 600` on the file as the repair, instead of reporting a parse failure. It also parses each file the way `--creds` does, so a file the NATS client cannot parse, such as one with Windows (CRLF) line endings, is a finding rather than healthy.
