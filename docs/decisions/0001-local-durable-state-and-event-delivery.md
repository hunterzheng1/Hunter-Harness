# Separate local durable state from event delivery

Planning Context and Plan publication state are authoritative local durable records scoped by explicit project/change identities. Each state change commits the bounded canonical payload, its descriptor, and append-only audit atomically with CAS and idempotency; Platform events are delivered afterward through a durable outbox. We do not pretend the filesystem and Platform RunStore share a distributed transaction: recovery explicitly represents committed-but-event-pending state, and legacy files are read-only migration inputs rather than a second write path.

