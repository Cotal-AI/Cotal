# Restart checkpoint

This branch preserves unpublished work before a workstation restart. It is not a merge candidate.

- First parent: `4ff17cf61ff8d66d49e4e07e2950ce2e79f62daa`, the held PR #7225 integration.
- Second parent: `5c08e565a75e91e771a5419c471aa55e82505818`, an unpublished seed-child revision. The separately submitted seed-child correction already merged through PR #7289.
- PR #7297 merged as `2708bfdc41fda2fecb6107fcb6a1c98943cf94ad`, closing #7295.

The held integration includes a correction that has since merged separately. Before resuming #7225, isolate only its remaining changes and bind validation to the resulting source. Existing proof applies only to its recorded heads. Do not merge this archive branch or treat its merge commit as a tested integration.

No existing PR branch is changed by this checkpoint. Publication of remaining work still requires coordination.
