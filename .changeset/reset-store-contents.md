---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

`cotal reset store` now says what goes with the store. Its preview has a "Store contents" section (`storeContents` in JSON), its confirmation and its receipt (`removedContents`) name workflow runs and their journals, channel history and stored messages, and the preview says that a run still waiting for an answer cannot be answered or resumed afterwards. The runs are not listed, because only the stopped broker reads the store; the preview names `cotal up` and `cotal run ps` to see them first. Before, a reset removed waiting runs and history with no word in the preview or the receipt.
