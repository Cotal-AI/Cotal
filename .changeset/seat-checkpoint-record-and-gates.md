---
"@cotal-ai/workspace": patch
---

Add seat checkpoints: the content-addressed record describing one preserved seat well enough to start it on another host, its writer and reader, the three admission gates a destination runs before it launches, and the per-seat writer generation that keeps one writer at a time.

The record carries the manager's resume entry unchanged as its first field, the generation it was cut at, `capturedAt`, the recency horizon, the continuity class and the applied profile revision. Every captured file is recorded by path, byte size and sha256, and the record is written last, after those digests are computed over the bytes that landed. The writer refuses a destination that already exists and hardens it to 0700 before anything lands.

Admission is three gates in order, each refusing with what it saw. Integrity: present, regular, non-symlink, size and sha256, with a re-stat after the read so a file that moved is a refusal. Identity: the recorded lifecycle uid is not live, the space matches, and the profile revision matches or is deliberately resumed under; this gate has no override. Recency: `capturedAt` against the destination clock and the horizon in the record, refused by default with all three values in the message, overridable by explicit operator consent that the caller records.

The writer generation is persisted beside the manager instance identity and claimed by exclusive create on the successor value before anything launches. It uses `createManagerInstanceIdentity`'s publication primitive and deliberately not its resolution: a lost create there adopts the winner, because two managers sharing one logical instanceId is intended; here a lost create means two hosts claiming one seat, so it refuses.
