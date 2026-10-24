---
"@cotal-ai/seat": patch
---

A pty seat whose startup confirmation prompt never appeared no longer answers that prompt after the
gate has failed. The failure stopped the child but left the prompt matcher live, so a child that
printed the prompt while stopping, for example from its SIGTERM handler, still received Enter after
the seat had reported the failure. The gate now ends before it reports a failure or once the child
exits, and answers no output after it ends.
