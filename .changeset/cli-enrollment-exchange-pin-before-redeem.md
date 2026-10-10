---
"@cotal-ai/cli": patch
---

`cotal spawn` with `COTAL_ENROLLMENT_URL` or `COTAL_ENROLLMENT_FILE` against a registered remote user-mode mesh whose record pins no exchange URL now refuses before it redeems the enrollment, with the same "records no exchange endpoint" sentence and re-registration step the provisioning path gives. It used to spend the one-time enrollment and then refuse with "the enrollment's authServiceUrl does not match the registered mesh exchange", which hid the missing pin.
