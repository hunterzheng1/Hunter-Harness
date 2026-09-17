# Remote Sync owns branch snapshot production

New Branch Snapshots are produced only by the authoritative Remote Sync commit path from explicit SourceRef, version, diff, tombstone, content-kind, and media-type inputs. Legacy finalize data without an explicit branch or commit remains unmarked and never guesses `main`; snapshot publication must participate in the remote commit transaction or a durable reconciled outbox, never a best-effort post-commit call.

