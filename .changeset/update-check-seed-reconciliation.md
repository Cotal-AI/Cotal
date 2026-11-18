---
"@cotal-ai/cli": patch
---

Update checks now report unfinished connector seeding and name the next step. Read seed journals and process custody without changing them, distinguish live seeding that needs a wait from interrupted seeding that needs repair, and preserve a failed seed's cause. Pending repair or unreadable seed state is partial with exit code 4. Update-recovery receipts retain precedence.
