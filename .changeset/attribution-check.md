---
---

Add an Attribution check on every pull request: the constituent commits, the PR title and the PR
body are graded against a closed grammar of AI attribution (Co-Authored-By trailers naming a tool,
"Generated with" footers, vendor mailboxes, fleet seat names, model ids) and the job fails closed
with a rewording instruction. Six squash merges on main carry such text because a squash body is
built from commit messages nobody re-reads; this reads the same material before the merge.
