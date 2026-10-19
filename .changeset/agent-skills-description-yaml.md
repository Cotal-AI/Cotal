---
---

The docs site sync now reads each Agent Skills description from the skill's YAML frontmatter with a YAML parser, so the discovery index publishes the text a folded or literal block, an escaped double-quoted string or a single-quoted string stands for. The sync refuses a skill whose frontmatter is missing or is not valid YAML, or whose description is not a non-empty string, and it no longer takes a body line that starts with `description:` for the description. The sync now depends on `yaml`. This changes the docs site and repository tooling only; no published package changes.
