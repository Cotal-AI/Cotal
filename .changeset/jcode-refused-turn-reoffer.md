---
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-jcode": patch
---

A Jcode seat no longer reports `done` for a manager turn its model never received.

Jcode acknowledges a message before it checks whether the API connection is still processing an earlier one, and then refuses the busy send with `Already processing a message`. The acknowledgement marked the send's manager turns as delivered, so a refused turn was never offered again. It settled as `done` at the seat's next turn boundary, or waited out its deadline when no boundary came. When the refusal answers the connector's latest send, those turns now go back to waiting and are sent again once the running native turn ends. `MeshAgent.unsurfaceTurns()` hands run turns back this way; a once task's confirmed handoff is unchanged.
