# NeatLogs observability

The API and Windows worker initialize the official NeatLogs Python SDK separately.
The Unix RQ workhorse initializes after fork and drains before exiting. With a
configured project key, metadata is exported in the background. Without a key, or
with NEATLOGS_ENABLED=false, local metadata logs still work.

## Configuration

Set these in the root .env (never commit the project key):

    NEATLOGS_ENABLED=true
    NEATLOGS_API_KEY=<your-project-key>
    NEATLOGS_ENDPOINT=https://ingest.neatlogs.com
    NEATLOGS_WORKFLOW_NAME=claim-evidence-assistant
    NEATLOGS_SAMPLE_RATE=1.0
    NEATLOGS_SHUTDOWN_TIMEOUT_MS=5000
    APP_VERSION=dev

EU projects use https://eu.ingest.neatlogs.com for both SDK and developer MCP.
APP_VERSION can be a Git commit hash (7–40 lowercase hex characters) to compare
releases. Prompt/instrumentation versions are attached as metadata. Restart the
native services after changing configuration, when no analysis is active.

## Find traces and investigate

Run from the repository root:

    .\backend\.venv\Scripts\python.exe -m app.observability_cli overview
    .\backend\.venv\Scripts\python.exe -m app.observability_cli search
    .\backend\.venv\Scripts\python.exe -m app.observability_cli trace
    .\backend\.venv\Scripts\python.exe -m app.observability_cli summary

overview reads the configured project's traces, enabled detections and fix count,
plus retained local metrics. search defaults to claim.analysis. trace opens the
newest result among the first 20 matches and retrieves every span page, so copying
a trace ID is optional. Filter a specific analysis with --run-id <analysis-id>,
or inspect an exact trace using --trace-id <trace-id>. Synthetic smoke traces use
--query claim.diagnostic. The command supports current and documented MCP result
shapes. Returned names/status/timing are shown; prompts, outputs and raw errors
are omitted. MCP calls are read-only; this application never changes triage state.

The developer MCP URL is https://ingest.neatlogs.com/mcp (or the EU equivalent),
authenticated by the project key in an Authorization bearer header. It is separate
from runtime SDK export. Credentials stay in backend configuration; no MCP key or
technical trace screen is added to the customer workspace.

## What is recorded

- One workflow trace per analysis attempt, correlated by opaque run UUID. Resumes
  produce another attempt trace using the same run UUID. Unrelated analyses do
  not share a session. Request traces and worker traces are separate, correlated
  through local run records rather than a single distributed queue trace.
- One graph callback handler per invocation records graph/node chain boundaries.
  Explicit agent spans record planner, evidence, policy and verifier operations.
  The custom HTTP model adapter adds one LLM span per actual model call. Tool and
  model spans nest under the explicit agent; graph callback nodes describe graph
  control flow separately. No provider auto-instrumentation adds duplicate calls.
- Extraction, retrieval, page reads, inventory, receipts and deterministic source
  checks; document UUID/version pairs, counts, correction counts and outcomes.
- API route templates, method, status, duration; OAuth and long-lived SSE routes
  are excluded from request tracing.
- Model slug, streaming completion/failure, duration, first-token timing, chunks,
  and provider-returned input/output/total/cache/reasoning tokens when present.

No dollar cost is estimated from ChatGPT plan tokens. Local cost_usd is null;
NeatLogs may display a provider value of zero, which is not a billing measurement.
Missing token usage is distinguishable from zero using calls_with_usage.

## Step record in the application

The same span stream is mirrored into the application database (table run_events) through
a recorder registered by the worker. It carries the allow-listed attributes only. The
Analysis workflow page and GET /business/metrics.csv read from it, so they work without
network access and show the same counts as the neatlogs trace. A failure to write a step
is logged as telemetry_degraded with reason step_record_failed and never stops an analysis.

## Privacy and failure behavior

The global SDK mask runs before export. It allowlists fixed operation names,
opaque identifiers and numeric metrics. It removes captured graph input/output,
model prompts/responses, document contents, filenames, request headers, exception
messages/stacks, events, links and machine resource identity. Raw log capture,
stdout capture, provider auto-instrumentation and media uploads are disabled.
Server-side PII project settings are preserved; local masking does not depend on
them. Full case facts stay in the existing local database.

Rotating metadata logs: logs/telemetry-api.jsonl, logs/telemetry-worker.jsonl and
logs/telemetry-diagnostic.jsonl. Existing logs/api.log and logs/worker.log remain.
They use the existing size/retention settings and are Git-ignored. summary reports
only retained history: completed/paused attempts, latency p50/p95, model calls,
known tokens and telemetry_degraded events. Synthetic spans are excluded from
claim metrics. These logs are not a durable offline replay queue.

Initialization/span/export/queue/masking failures record telemetry_degraded locally
and do not retry or fail claim processing. SDK delivery counters are checked in a
background thread. Graceful API/worker shutdown flushes and shuts down once with
bounded deadlines. Force-killing a process, including the native stop script, can
lose its buffered telemetry; stop only after active jobs finish.

## Verification commands

    .\backend\.venv\Scripts\python.exe -m app.observability_cli doctor-local
    .\backend\.venv\Scripts\python.exe -m app.observability_cli doctor-probe

Local Doctor is network-free. Hosted Doctor verifies its own four-span trace,
not the claim application. Both must report neatlogs.doctor/v2, Python, schema 2.

To exercise the actual graph and OAuth model adapter on fictional documents:

    .\backend\.venv\Scripts\python.exe -m app.observability_smoke

This makes real model calls using the signed-in account. It creates a temporary
claim database, emits a marked synthetic diagnostic trace, prints its trace ID,
and closes/removes temporary data. Saved user cases are unchanged. Investigate it:

    .\backend\.venv\Scripts\python.exe -m app.observability_cli trace --query claim.diagnostic

## Verified on 10 October 2026

SDK 1.4.26 was resolved from PyPI and locked in backend/uv.lock. Local Doctor and
hosted Doctor passed. The configured project has three enabled conditional
detections and zero triage cards at verification time; detection hit-rate fields
were not returned, so no alert frequency is claimed.

The live synthetic application trace aee07ab9c07415e5132ae036267853b8 completed
in approximately 83.4 seconds, with two findings, nine Luna calls and 12,532
provider-returned tokens. It includes a policy call and bounded corrective work;
review remained required. This checks instrumentation, not clinical correctness
or measured evidence accuracy. See the verification record below for complete
span readback and masking checks. No previous analyses can be backfilled with
spans that were never recorded.

## Official references

- https://docs.neatlogs.com/sdk/python
- https://docs.neatlogs.com/integrations/langchain
- https://docs.neatlogs.com/sdk/pii-redaction
- https://docs.neatlogs.com/sdk/lifecycle
- https://docs.neatlogs.com/sdk/doctor
- https://docs.neatlogs.com/integrations/mcp
- https://docs.neatlogs.com/integrations/mcp-tools

Complete hosted readback retrieved all **75 spans**, with one root, unique span
IDs, valid parent relationships and numeric token totals. The synthetic claim
reference, diagnosis, signature name and filename were absent from remote data.
The backend suite passed **56 tests**, including metadata masking, real SDK graph
hierarchy/usage, failure isolation, pagination and Windows temporary DB cleanup.
