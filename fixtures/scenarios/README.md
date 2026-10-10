# Sample scenarios

Five fictional document sets, one per scenario in Health_Claim_Architecture.md. Every file
begins with a "SYNTHETIC APPLICATION TEST DATA" banner. No real patient, hospital, insurer
or signature is represented.

They appear on the home screen under "Sample cases with made-up documents". Opening one
creates a claim with its documents; running the analysis uses the connected model.

Each folder has a scenario.json with the claim reference, the documents and their categories,
an optional follow_up round, and an `expected` block. The expected block is kept away from the
agents: it is never sent to the model or shown in the workspace.

Keep the files byte-for-byte as committed (.gitattributes disables line-ending conversion):
the acknowledgement in scenario 2 quotes the SHA256 of the bill beside it.

## What each scenario checks

| Folder | Situation | Behaviour to look for |
| --- | --- | --- |
| 01-document-completeness | The insurer wants the final discharge summary and a lab report; only a summary marked provisional is on file. | The provisional summary is not accepted as final. The lab report is reported as absent, not guessed. Submission stays unproven. |
| 01, follow-up | The final summary is added as version 2 of the provisional one, with the lab report. | Both points become supported in a new report; the earlier report is kept and can be compared. Submission is still unproven. |
| 02-repeated-request | A second request for a bill that was already acknowledged. | The bill is matched to the acknowledgement by invoice number, version and hash; receipt is confirmed only because the acknowledgement names that file. |
| 03-deduction-confusion | Three deductions, with bill, wording, schedule and an endorsement. | One finding per deduction with policy citations. The co-payment deduction conflicts with the schedule (age 45) and endorsement E-02. |
| 04-rejection-dispute | Rejection for a waiting period and for non-disclosure. | One issue per reason. The stated inception date is contrasted with the schedule. A reconsideration draft with no accusation and no promise. |
| 05-conflicting-invoices | Two copies of an invoice with different totals and member IDs. | Reported as inconsistent evidence needing review, never as fraud. Missing hospital explanation and payment receipt are listed. |

## Live results recorded on 10 October 2026

Run through the workspace in Chrome against gpt-6-luna. These are single runs on synthetic
documents: they show the workflow behaving as designed, not a measured accuracy rate, and a
later run can word things differently or choose a neighbouring status.

| Scenario | Findings (evidence / submission) | Review | Matches the label |
| --- | --- | --- | --- |
| 01, first round | summary: partially satisfied / not established; lab report: partially satisfied / not established | none | yes |
| 01, after follow-up | summary: satisfied / not established; lab report: satisfied / not established | none | yes |
| 02 | bill: satisfied / confirmed by receipt | flagged: the reminder conflicts with the acknowledgement | yes |
| 03 | room rent: partially satisfied; consumables: partially satisfied; co-payment: conflicting evidence, wording contradicts the insurer's reason | all three flagged | yes |
| 04 | waiting period: conflicting evidence, wording contradicts the insurer's reason; non-disclosure: partially satisfied, wording unclear | both flagged | yes |
| 05 | which total is correct: conflicting evidence; hospital explanation: partially satisfied; payment receipt: partially satisfied | all three flagged | mostly: the two missing documents were labelled "not found" and came back "partially satisfied", with explanations that correctly say they are absent |

No report contained fraud, forgery, bad-faith or guaranteed-outcome wording. The planner split
scenario 5 into three requests where the label lists two, because the letter asks for the
correct total and the hospital's explanation in one sentence.

A separate recovery check stopped every process while scenario 4 was being analysed. On restart
the worker re-queued it, it resumed from its checkpoint and produced exactly one report.
