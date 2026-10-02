---
"cotal-ai": patch
---

Tag the GitHub Release at the commit that first carried the version, which is the tree the packages were published from. A publishing run whose closure gate ended `UNSETTLED` left the Release to the next push that saw closure, and that push tagged itself, so the Release named a commit carrying changes absent from the published tarballs. The release step now fails when it cannot resolve that commit.
