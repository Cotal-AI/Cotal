---
"@cotal-ai/cli": patch
---

The guided `cotal meshes add` no longer replaces a registered record when you press Enter through its defaults. When it would replace one, its last question is now "Replace the record for "<space>"?", and only a typed `y` or `yes` confirms it; Enter keeps No and nothing is written. Before, that question was "Register this mesh?" with Yes as the default, so Enter replaced the record of a space this machine had started, and `cotal down` there could then no longer stop its broker. A cancel at any of its questions now says "Cancelled. Nothing was registered." instead of "Setup cancelled."
