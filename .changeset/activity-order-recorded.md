---
"@cotal-ai/web": patch
---

The dashboard's all-activity backfill now records its ordering rule where the page is sorted and in the dashboard docs. The chat half is the newest messages by broker arrival, the merged page with direct messages is ordered by the sender's `ts` because that is the only key the two streams share, and messages with equal `ts` keep stream order with chat before direct messages. Behaviour is unchanged.
