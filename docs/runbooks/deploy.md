# Runbook: Deploy (web and API)

**Owner:** DevOps

1. Confirm release checklist pre-release items are ticked.
2. Merge release PR to `main`; CI builds container images once and tags them with the commit SHA.
3. Images auto-deploy to dev, then promote the same tag to staging.
4. QA signs off staging.
5. Promote the tag to production (manual approval in CI by the tech lead).
6. Migrations run first (expand step only); then blue-green switch on ECS.
7. Watch dashboards for 30 minutes: 5xx rate, p95 latency, queue depth, payment webhook processing, message delivery.
8. If any alarm fires, follow `rollback.md`.
9. Record the release (version, SHA, migrations, approver).

## API container memory (PDF rebuilds)

Uploaded PDFs are rebuilt in a worker thread inside the API process (threat model T27). On a hostile file one worker adds up to about 350 MB to the process before it is stopped (128 MB heap, polled every 20 ms; 128 MB of decoded stream data; the upload and its copy).

- **`PDF_REBUILD_CONCURRENCY`** (default `1`, allowed 1 to 4): rebuilds run at once per API task. At most twice that many wait (10 seconds each); beyond that uploads get 503 with `Retry-After: 60`.
- **Container memory:** at least **1 GB** for an API task at the default, plus **400 MB for each further concurrent rebuild** (2 GB covers `PDF_REBUILD_CONCURRENCY=3`). Raise the setting only together with the task's memory.
- A `--max-old-space-size` in `NODE_OPTIONS` overrides the worker's own heap limit; the API still stops a worker past 144 MB by polling, so setting it is safe, but it does not give the rebuild more memory.
- At start-up the API rebuilds a sample PDF and logs `PDF rebuild self-test passed`. **`PDF rebuild self-test failed`** (error) means every PDF upload will get 503 `unavailable`: check that `dist/pdf-rebuild-worker.js` is in the image beside `dist/server.js`, and that `pdf-lib` was not upgraded (its decoders must be cappable). Roll back if unsure (`rollback.md`).
- Watch for `PDF rebuild failed` errors and a rising rate of 503 on `POST /v1/document-files`.
