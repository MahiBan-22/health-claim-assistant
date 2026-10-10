# neatHack 2026: requirements and evidence

Checked against https://neatlogs.com/hackathon on 10 October 2026. The page states:
"Your project must use neatlogs, Entire and cfo.ai." LiteLLM, AWS and Crustdata are
offered as optional resources.

The same information is served live from the installation by `GET /system/integrations`.
The home-screen section that displayed it was removed from the landing page on
11 October 2026.

## Required tools

| Tool | Required for | Status here | Where |
| --- | --- | --- | --- |
| neatlogs | "Trace every agent run." | Integrated and exporting. | Python SDK 1.4.26 in the API and the worker. One trace per analysis attempt: planner, policy, evidence and verifier agent spans, every tool call, every model call with token counts. A masking function allow-lists step names, counts and opaque IDs before export. See [observability.md](observability.md). |
| Entire | "Give your coding agent repository context." | Enabled in this repository on 10 October 2026. | The repository's `origin` is hosted on Entire. `entire enable` installed hooks for Claude Code and Codex and git hooks; checkpoints are stored as git refs and sync to `origin` on push. Settings are in `.entire/settings.json`. |
| cfo.ai | "Plan the business with cfo.ai" and include the plan in the submission. | Export bridge built; **the plan itself still has to be created in cfo.ai**. | `GET /business/metrics.csv` exports monthly totals measured by the app; open http://127.0.0.1:8000/business/metrics.csv to download it (the home-screen button went with that section). Nothing in this repository can create the plan: it needs a cfo.ai account. |

Optional resources not used: Crustdata, LiteLLM, AWS. The model is gpt-6-luna through
Sign in with ChatGPT.

## Still to do by a person

1. **cfo.ai plan.** Sign up at cfo.ai/neathacks, import the metrics CSV, add the
   assumptions the app cannot measure (price, customer volume, reviewer hourly cost,
   opening cash, fixed costs) and build the plan covering pricing, costs, revenue and
   runway. Keep measured and assumed inputs labelled.
2. **Entire checkpoints.** Tracking started after today's commits, so no checkpoint
   exists yet. The next commit made from a tracked Claude Code or Codex session creates
   one; `entire checkpoint list` shows it. Approve the Codex hooks with `/hooks` in
   Codex. Session logs upload with `git push`; they can contain anything an agent read,
   so keep real records and secrets out of agent sessions.
3. **Submission.** Demo video, public posts tagged #neatHack, and the quote of the
   official neatlogs post with team, project, public repository and demo.

## Evidence the page asks for

**neatlogs traces.** The project holds one `claim.analysis` trace per analysis. Find them
with `python -m app.observability_cli search`, or open one with `--trace-id`.

**Agent improvement, before and after.** Scenario 3 (three deductions) on the same
documents:

| | Before | After |
| --- | --- | --- |
| Change | Evidence step ran before the policy step; one yes/no verdict per finding | Policy step runs first; the verifier names unsupported statements and the writer gets one correction |
| neatlogs trace | `0b5598700a124e8ba255e4dd47ef05aa` | `e623977e32bcc4bf05c30eba43640a56` |
| Findings withheld from the customer | 3 of 3 | 0 of 3 |
| Co-payment conflict with the endorsement shown | No | Yes |
| Model calls | 10 | 13 |
| Model tokens | 30,952 | 41,352 |
| Correction loops | 0 | 1 |
| Duration | 142.8 s | 142.1 s |

The improvement cost three more model calls and about 10,400 more tokens. One run each:
this shows the change working, not a measured rate.

**Recovery.** Every process was stopped while analysis `7a0093f0` (scenario 4) was
running. On restart the worker logged `analysis_recovered count=2`, re-queued it, and it
resumed from its checkpoint and finished in 38.8 s with exactly one report. The resumed
attempt is trace `d68144e4d9da3abe5c2afd5f5bb873f7`. The interrupted attempt
(`01a65e5ed2ffd008684f5d1a795c5fb2`) was killed before it could export, so it exists only
in the local telemetry log; the Analysis workflow page for that run shows both attempts.
The worker also restarted its own loop twice after "Redis connection timeout", which
previously stopped it for good.

**Each analysis, step by step.** The Analysis workflow page draws the recorded steps of
any analysis as a flowchart, live while it runs.

## The eight focus areas

| Focus | Where it happens |
| --- | --- |
| Planning | The planner turns the insurer's letter into separate points, with a category and whether policy wording is needed. |
| Tool use | Agents call typed local tools: list documents, search pages, read a cited page, find acknowledgements. |
| State | LangGraph checkpoints after every step; each analysis freezes the document versions it read. |
| Context | Each agent gets only the pages retrieved for its point; the policy reading is passed to the evidence step. |
| Execution | An RQ worker carries each queued analysis through to a report, reply letter and attachment manifest. |
| Recovery | Bounded transport retry, a self-restarting worker loop, and re-queuing of interrupted analyses. |
| Verification | Deterministic citation and identifier checks, then a verifier model that tests each statement against the cited page. |
| Iteration | A failed check or an unsupported statement sends the point back once with a targeted correction. |
