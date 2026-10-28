---
"@cotal-ai/workspace": patch
---

On a terminal, a `→ using`, `→ wrote` or `→ removed` line now wraps at spaces like the CLI's other notices, each continuation line under the text after the arrow. A path too wide for the rest of the line, such as the one `cotal spawn` names after `→ using persona:`, goes on the next line whole. It used to be one line however wide, so an 80-column terminal broke the path mid-word. Written to a pipe or a file the line stays one line, unchanged.
