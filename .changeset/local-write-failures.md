---
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
"cotal-ai": patch
---

Local write failures now name the affected file, explain the storage limit and offer a next step.
Failed preference replacements and persona catalog commits preserve the saved destination, and
persona draft failures are no longer called invalid input. Space creation also classifies adoption
journal failures and reports earlier changes when preparation or default-persona writes fail.
Default-persona seeding and legacy migration still write in place and may leave an incomplete file;
inspect the named file before retrying. Failed lock and prepared-record writes clean up their
temporary files.
