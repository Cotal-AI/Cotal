---
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-claude-code": patch
---

Keep weighted term frequencies instead of repeated token strings in the lazy documentation search index. Search results and BM25 scores are unchanged. This reduces retained memory after documentation searches in the tested stock connector workload, with extra first-search work to build the frequency maps.
