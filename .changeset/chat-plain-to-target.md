---
"@cotal-ai/cli": patch
---

In `cotal chat --plain`, `:to <target>` now sets the recipient. `:to eve` or `:to @eve` became a draft to the current channel, and answering `y` would have posted that text. `:to @eve`, `:to #<channel>`, `:to @<owner>.<actor>` and `:to role:<role>` now choose that recipient, and a target in another form, such as a bare name, names the forms it accepts and opens the numbered list. The docs now describe `:to`, `:multi` and the other line commands.
