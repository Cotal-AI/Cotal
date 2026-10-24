---
"@cotal-ai/cli": patch
---

`cotal down` now says when a stack member stopped by signal did not exit within 15 seconds of SIGTERM and was killed. Its row reads `stopped with SIGKILL`, and a `STOP_ESCALATED` warning names the member and its pid in the receipt and in `--json`. The receipt used to say only `stopped`, and only `service status` showed the recorded SIGKILL.
