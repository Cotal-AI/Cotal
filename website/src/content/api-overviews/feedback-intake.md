The Feedback intake HTTP API accepts reports from provisioned testers and stores them before publication to the feedback channel.

## Connection

The default address is `http://127.0.0.1:8787`. The operator can configure a different host or port.

## Authentication

`GET /health` requires no credentials. Feedback submissions require a provisioned tester key in the bearer header.

## Submission limits

The body limit defaults to 64 KiB. The rate limit defaults to 30 authenticated admissions per tester per minute.
An invalid body still consumes an admission. The operator can configure both limits.

## Accepted reports

HTTP 202 means the record was stored. A response with `published: false` still represents an accepted report.
It does not confirm publication to the channel. The submission page describes the request fields and response codes.
