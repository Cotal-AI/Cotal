---
"@cotal-ai/cli": patch
---

`cotal update` now removes group and other write from the folders and files you own in Cotal's config directory (`$XDG_CONFIG_HOME/cotal` or `~/.config/cotal`), as it already did for Cotal's install, and prints `✓ removed group and other write from <n> entries in Cotal's config at <path>`. An earlier seed run under a umask of 0002 left that directory and its extension tree group-writable. Where the private-group proof was unavailable, as under SSSD, the web seed refused them and the update failed after its install repair had run. A group-writable folder above the config directory, such as `~/.config`, is not Cotal's: `update` leaves it unchanged, the seed still refuses it with `chmod g-w <path>` as the next step, and the update still exits nonzero.
