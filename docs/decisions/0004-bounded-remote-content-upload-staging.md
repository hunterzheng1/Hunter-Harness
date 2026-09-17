# Stage remote content through bounded opaque uploads

Remote Sync and Archive publish stage binary content through one bounded upload operation that returns a project-, actor-, source-, hash-, size-, expiry-, and idempotency-bound opaque reference; prepare and commit consume that reference without embedding bytes in JSON. The first production protocol is a single streamed upload with exact length and SHA-256 verification, not base64 JSON, Range, resumable chunks, or a caller-supplied filesystem path; ambiguity is resolved by scoped status lookup before retry.

