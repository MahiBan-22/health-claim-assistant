# Workspace starter documents

All files are fictional UTF-8 text records accepted by the current application.
No real patient, hospital, insurer, or signature is represented.

Create case title: Synthetic dengue test
Claim reference: SYN-DEMO-001

## Round 1: upload only these four files

| File | Select document type | Expected interpretation |
| --- | --- | --- |
| 01-insurer-query.txt | insurer_communication | Three separate document requests |
| 02-provisional-summary.txt | clinical | Partial evidence for a final summary; not satisfied |
| 03-itemized-bill.txt | bill | Itemized bill available |
| 04-bill-acknowledgement.txt | receipt | Bill receipt supported by its exact SHA256; no receipt for other documents |

Expected request findings: final summary partially satisfied; itemized bill
satisfied with confirmed receipt if the verifier establishes the matching scope;
laboratory report not found in available records. A reference to a lab report in
the summary is not the lab report itself. No approval or payment is guaranteed.

## Round 2: add the missing evidence

Upload 05-laboratory-report.txt as clinical, with Version of set to New document.
Upload 06-final-summary.txt as clinical, with Version of set to the existing
02-provisional-summary.txt. This creates version 2 while retaining the original.
Start a NEW analysis so it snapshots the new evidence, rather than resuming the
old analysis, which preserves its original inputs.

Expected interpretation: final summary and laboratory report are now available;
submission to the insurer remains not established for both. Bill receipt remains
separate. Preserve the first report to compare results across input versions.

The bill acknowledgement includes the SHA256 of the exact supplied bill file.
Upload that file without editing it or changing its encoding; otherwise the hash
will correctly cease to match.

These are expected evaluation targets, not recorded live model results. Uploads
can be tested now. Live analysis requires the application's authorized ChatGPT
connection. Run the native workspace and select Continue with ChatGPT before
starting analysis; account access to the configured Luna model is checked.
