---
"@cotal-ai/cli": patch
---

Direct spawn previews now refuse names that foreground launch would reject locally.
The effective name from `--name` or persona frontmatter uses the shared launch validator,
including actor-token restrictions on selected user-auth spaces.
