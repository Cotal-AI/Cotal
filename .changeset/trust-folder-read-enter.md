---
"@cotal-ai/workspace": patch
---

Say that a project's trust folder must be one this account can read and enter. A `.cotal/auth` that
lists its files but cannot be entered, such as one at mode 0600, is refused with
`DEPENDENCY_UNAVAILABLE`, and its next step said only to make it a folder this account can read,
which a folder at 0600 already is. The next step now says to make it a folder this account can read
and enter, or to name a space with `--space <name>`. The error code, the folder named, and every
other next step are unchanged.
