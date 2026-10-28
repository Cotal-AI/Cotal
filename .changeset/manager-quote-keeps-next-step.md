---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
---

A manager that fails while it starts now ends its line in a next step the operator can take, and the refusal that quotes the line keeps that step.

The service controller quoted the last line a failed service logged cut at 400 characters, so the line of a manager that did not trust a local CA, over 500 characters long, lost its `; next:` part. The quote now holds a line up to 1000 characters whole, and a longer line keeps its start and its last `; next:` step, with its length where the middle was cut. When the error a manager's startup fails on ends in a certificate this machine does not trust, such as `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, the line keeps Node's message as the cause and its next step is to set `NODE_EXTRA_CA_CERTS` for the command that starts the manager. A seat-cap record that cannot be read names its path, and the line gives one next step, to remove or repair that record. The generic step the startup failure's message repeated is gone. Under `--foreground` on a terminal, the manager's line wraps at the terminal's width as the CLI's own lines do; in its log it stays on one line.
