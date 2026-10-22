---
"@cotal-ai/core": minor
"@cotal-ai/cli": minor
---

A new Claude app conversation identity now needs a person's approval before anything is issued.

`cotal app-identity provision` sends a new request only to a signed-in mesh whose authority advertises connection approval v1. Until the person approves it in the authority's signed-in web page, provision answers `{"ok":false,"pending":true,"requestId","approval":{"id","url","expiresAt"},"proposed"}` with no credential, secret or path, and nothing is issued. Provisioning again sends the same saved request and secret. Once approved, the grant is exactly what the person approved, which can differ from the request. A denial or an expiry drops the request, and the next provision asks again. A model's tool arguments or a client flag never approve one.

A mesh with static credentials, an open mesh, and a signed-in mesh whose authority this machine holds have no approval page, so provision now refuses on them instead of opening an identity. A host without connection approval is refused before any authenticated request, including one without a selection. Identities issued before this change keep working: a saved signed-in identity resumes exactly, and `retire` still removes a static identity an earlier version opened.

Every identity still sends and receives direct messages and publishes its own activity on its own event channel. A request without a selection proposes nothing beyond those.

Core exports the approval types `ConversationProposal`, `ConversationApprovalPending`, `ConversationApprovalDecision` and `ConversationPending`, the constant `EMPTY_CONVERSATION_SELECTION`, and the parsers `checkConversationProposal`, `checkConversationApprovedSelection`, `checkConversationApprovalPending`, `checkConversationApprovalDecision`, `checkConversationPendingAnswer` and `conversationApprovalRefusal`.
