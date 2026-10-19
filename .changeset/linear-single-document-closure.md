---
"@cotal-ai/linear": patch
---

The Linear endpoint's service contract builds its §13.7 closure manifests with core's `singleDocumentClosure`, as the auth and manager contracts do, instead of writing each manifest by hand. A change to core's manifest rule now reaches the Linear cluster document and its command digests too. Every digest it publishes today is unchanged.
