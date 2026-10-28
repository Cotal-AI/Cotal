---
"@cotal-ai/workspace": patch
---

A report's section title wider than the terminal now wraps at its words, and each of its lines keeps the title's style. At 40 or 60 columns `cotal docs --search manager` drew hit titles of up to 77 characters, such as `Upgrading a running deployment › Starting the manager by name after 0.105.0`, on one line past the terminal's edge. A title that fits is drawn as before.
