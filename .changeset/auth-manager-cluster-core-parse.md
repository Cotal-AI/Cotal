---
"@cotal-ai/auth": patch
---

The auth plane now derives the remote manager's serve surface from the cluster document core parsed, instead of re-checking the raw document with its own field checks. Activation parses the submitted `ai.cotal.manager` document with core's parser, and standing renewal and run attempts use the document core verified at registration. A manager cluster that declares a journal-class command, which core admits and registers, is now refused with `EpEnvelopeError` `failed-precondition` naming the command. Before, it was refused with a plain `Error` and no code, as was an activation request that submits no manager cluster document, which is now refused `bad-request`. The stock manager cluster is all ephemeral, so stock activation, renewal and runs are unchanged.
