---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
---

A spawn acceptance replayed to a resubmission now names the owner the manager allocated. On a user-auth mesh, a sibling instance, a restarted instance or a bind race rebuilt the acceptance from the goal index or the goal terminal with the static mesh's `local` owner, and the terminal rebuild also used the composite `owner.actor` id as the actor, so a caller that addressed the agent by it reached a principal that was never allocated. The goal-index acceptance floor now records the owner beside the actor and uid, and the terminal rebuild splits the user-mode principal. A floor written by an older manager names no owner, so a resubmission served from it is refused `unavailable`.
