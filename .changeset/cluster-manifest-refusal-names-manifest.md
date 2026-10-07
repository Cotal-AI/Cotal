---
"@cotal-ai/core": patch
---

`verifyClusterManifest` now names the manifest when the manifest itself is malformed. A manifest that is not an object, whose `v` is not 1, whose `root` is not a digest or whose `members` is not an array used to refuse with `cluster document does not validate: manifest ...`, which pointed at the root document. A host that registered with `clusterDigests` set to its cluster document's digest instead of its manifest's got that message for a document that was valid. The refusal now reads `cluster manifest <closure digest> does not validate: ...`, and `parseClusterDocument` keeps the `cluster document` prefix for faults in the document.
