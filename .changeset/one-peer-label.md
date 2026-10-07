---
"@cotal-ai/core": patch
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-hermes": patch
"@cotal-ai/cli": patch
---

The connector and the CLI now print every peer with one label, from the new `peerLabel` in `@cotal-ai/core`: `name/role`, or the bare name for a peer with no role, with any line break or bracket shown as a space. Before, `cotal console` dropped a role equal to the name and its roster pane showed the name alone, the console's managed-agent row and the spawn line printed `name (role)`, and only message attribution sanitized the role, so `cotal_roster`, the orientation card, the ambiguous-DM candidate list, `cotal endpoints`, `cotal status` and `cotal ps` printed a role holding `]` or a newline verbatim. The DM target check that refuses a pasted label compares against the same label.
