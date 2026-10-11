# Documents in other formats

Four fictional files for trying PDF and Word uploads. They hold the same made-up claim as
`workspace-starter` (claim reference SYN-DEMO-001) and carry the "SYNTHETIC APPLICATION TEST
DATA" banner. No real patient, hospital, insurer or signature is represented.

Create a claim with the reference SYN-DEMO-001, then add all four.

| File | What it is | How it is read |
| --- | --- | --- |
| 01-insurer-query.docx | Word letter with a letterhead | Typed text copied exactly; the letterhead is kept once, on page 1 |
| 02-final-discharge-summary-scan.pdf | Two scanned pages with no text layer: a signed, stamped summary and its blank back | Each page read by the connected model; the signature and seal are marked, the blank page is recorded as blank |
| 03-itemized-bill.pdf | PDF with a text layer and a table | Text layer copied exactly; the model is not called |
| 04-bill-acknowledgement.docx | Word letter with a table and a picture of a desk stamp | Typed text copied exactly; the stamp picture read by the connected model |

Files 02 and 04 need the AI engine available. Without it the scan is stored as unreadable and the
stamp is counted as an unread picture, unless Tesseract is installed.

## Live result recorded on 11 October 2026

Read through the application's own extraction against gpt-6-luna. One run on clean synthetic
pages: it shows the reading working, not a measured accuracy rate.

| File | Result |
| --- | --- |
| 01-insurer-query.docx | 1 page, exact, no model call |
| 02-final-discharge-summary-scan.pdf | 2 pages in 7.6 s; every line correct; `[signature]` and `[seal]` marked; page 2 blank |
| 03-itemized-bill.pdf | 1 page, exact, no model call |
| 04-bill-acknowledgement.docx | 1 page in 4.2 s; all four lines of the stamp correct |

A separate dense test page (58 lines of 8-point print with 105 amounts, rotated and blurred)
was copied with every line and every amount correct.
