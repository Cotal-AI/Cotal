---
---

The required `attribution` check now also refuses a pull request until its body carries an `Approved-at: <sha>` paragraph naming the PR's current head in full. A line in a code block or an HTML comment does not count. Nothing compared the sha a review verdict named with the sha that merged, so a PR could merge commits pushed after its review with every required check green. This changes repository tooling only; no published package changes.
