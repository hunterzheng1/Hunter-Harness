# Keep archive bytes in a controlled local CAS

Archive ZIP bytes are owned by a project-scoped local CAS and referenced durably by opaque identity, content hash, and size rather than raw paths. Archive publication uses capability-fenced durable outbox transitions and the Remote Sync Archive transport; cleanup is a separate acknowledged transition, while legacy archive endpoints and v1 records remain read-only compatibility inputs.

