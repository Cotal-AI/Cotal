---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

The guided `cotal meshes add` on a terminal now reports a TLS broker whose certificate this machine
does not trust as the flag form does: the handshake failed, and `NODE_EXTRA_CA_CERTS` names the
issuing CA. It used to say the broker did not answer and offer another address first. Cancel is now
the first choice there, and registering the address anyway is still an explicit choice. A host name
the guided form refuses for lacking TLS now gets the flag form's next step, the `tls://` form of the
address, and the question that asks again shows no plaintext example. The guided form's refusals
and warnings now wrap to the terminal.
