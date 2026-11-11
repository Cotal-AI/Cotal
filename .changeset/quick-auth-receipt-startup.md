---
"@cotal-ai/auth": patch
---

Auth service restarts no longer wait for the full history of connection receipts before opening HTTP listeners. Native receipt cleanup continues in bounded background batches, keeps service evidence, fences on corrupt evidence and stops between store operations when the service closes.
