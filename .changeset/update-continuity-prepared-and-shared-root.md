---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

`cotal update` and `cotal update --self` no longer refuse the software update over registrations that hold no manager on this machine. A space prepared here that never started (`cotal setup --configure-only`, `space create`), whether it is this folder's space, selected or named, is named and skipped like a stopped one instead of answering "is prepared but not started - start it with cotal up". A folder that holds several registrations, such as two remote spaces registered there with `space add --from`, is read one registration at a time, each by name, instead of refusing with "multiple meshes running" and reading none; the resolver's per-folder ambiguity now carries the space names for that.
