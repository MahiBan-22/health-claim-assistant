import { test, expect, type Page } from "@playwright/test";

// Every API call is answered here with fictional data: no real claim is read or changed and no model is called.
const claim = {
  id: "case-1",
  title: "Hospitalization reimbursement",
  claim_reference: "CLM-2026-0142",
  created_at: "2026-10-09T07:00:00Z",
  document_count: 3,
  analysis_count: 2,
  report_count: 1,
  latest_status: "completed",
  sample_key: null,
  sample_follow_up: null,
};
const document = (id: string, filename: string, kind: string, extra = {}) => ({
  id,
  logical_id: id,
  filename,
  kind,
  version: 1,
  extraction_status: "extracted",
  created_at: "2026-10-09T07:05:00Z",
  page_count: 1,
  claim_references: ["CLM-2026-0142"],
  in_use: true,
  is_latest: true,
  ...extra,
});
const docs = [
  document(
    "doc-1",
    "Insurer clarification request.pdf",
    "insurer_communication",
  ),
  document("doc-2", "Hospital discharge summary.pdf", "clinical"),
  document("doc-3", "Itemized hospital bill.pdf", "bill", { version: 2 }),
];
const runs = [
  {
    id: "run-2",
    case_id: claim.id,
    created_at: "2026-10-10T08:00:00Z",
    status: "completed",
    error: null,
    report_id: "report-1",
  },
  {
    id: "run-1",
    case_id: claim.id,
    created_at: "2026-10-09T07:00:00Z",
    status: "paused",
    error: "The model connection dropped; resume to continue",
    report_id: null,
  },
];
const finding = {
  request_id: "r1",
  evidence_status: "partially_satisfied",
  submission_status: "not_established",
  explanation:
    "The summary on file is marked provisional. The final signed version is not among your documents.",
  response_text: "The record I hold is marked provisional.",
  evidence_refs: [
    {
      document_id: "doc-2",
      version: 1,
      page: 1,
      quote: "PROVISIONAL DISCHARGE SUMMARY",
    },
  ],
  policy_refs: [],
  receipt_refs: [],
  unresolved_questions: ["Has the hospital issued the final summary?"],
  next_action: "Ask the hospital for the final signed discharge summary.",
  review_required: true,
  review_reasons: ["Two records disagree on the discharge date."],
};
const report = {
  id: "report-1",
  case_id: claim.id,
  run_id: "run-2",
  version: 1,
  model: "gpt-6-luna",
  created_at: "2026-10-10T08:02:00Z",
  claim_reference: claim.claim_reference,
  review_required: true,
  requests: [
    {
      request_id: "r1",
      text: "Provide the final signed discharge summary.",
      category: "document_request",
    },
  ],
  findings: [finding],
  response_draft:
    "Dear Claims Team,\n\nThe record I hold is marked provisional.",
  customer_draft: null,
  completed_actions: [],
  attachment_manifest: [
    {
      document_id: "doc-2",
      version: 1,
      filename: "Hospital discharge summary.pdf",
      kind: "clinical",
    },
  ],
  input_versions: docs.map((d) => ({
    id: d.id,
    filename: d.filename,
    version: d.version,
    kind: d.kind,
  })),
  warnings: [],
};
const queueItem = {
  task_id: "run-2:r1",
  report_id: report.id,
  report_version: 1,
  case_id: claim.id,
  case_title: claim.title,
  claim_reference: claim.claim_reference,
  created_at: report.created_at,
  current: true,
  request: report.requests[0].text,
  finding,
  decisions: [] as unknown[],
};

async function workspace(page: Page) {
  const saved: { method: string; path: string; body: unknown }[] = [];
  await page.route("http://127.0.0.1:8000/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (method !== "GET")
      saved.push({ method, path, body: request.postDataJSON?.() ?? null });
    if (path.endsWith("/analysis-events"))
      return route.fulfill({
        contentType: "text/event-stream",
        body: "data: " + JSON.stringify(runs) + "\n\n",
      });
    let body: unknown = {};
    if (path === "/cases") body = [claim];
    else if (path === "/samples") body = [];
    else if (path === "/system/status")
      body = {
        api: true,
        database: true,
        redis: true,
        workers: 1,
        queued: 0,
        ocr: false,
        model: "gpt-6-luna",
        counts: { cases: 1, documents: 3, analyses: 2, reports: 1, active: 0 },
      };
    else if (path === "/auth/chatgpt/status")
      body = {
        connected: true,
        storage_available: true,
        email: "test@example.test",
        model: "gpt-6-luna",
      };
    else if (path === "/auth/chatgpt/models")
      body = { selected_model_available: true };
    else if (path.endsWith("/documents")) body = docs;
    else if (path.endsWith("/documents/doc-2"))
      body = {
        ...docs[1],
        pages: [
          {
            page: 1,
            text: "Hospital: Example\nDocument designation: PROVISIONAL DISCHARGE SUMMARY\nSignature status: unsigned",
            readable: true,
          },
        ],
      };
    else if (path.endsWith("/analyses")) body = runs;
    else if (path.endsWith("/timeline"))
      body = [
        {
          date: "2026-10-01",
          label: "Admission date: 1 October 2026",
          document_id: "doc-2",
          filename: docs[1].filename,
          kind: "clinical",
          version: 1,
          page: 1,
        },
      ];
    else if (path === "/reports/report-1") body = report;
    else if (path === "/reports/report-1/reviews") body = [];
    else if (path === "/review-queue") body = [queueItem];
    else if (path.endsWith("/review"))
      body = {
        id: "review-1",
        task_id: queueItem.task_id,
        reviewer: "Asha",
        decision: "approved",
        rationale: "Checked",
        created_at: "2026-10-10T09:00:00Z",
      };
    await route.fulfill({ json: body });
  });
  return saved;
}

test("opens without a login and walks from documents to a verified reply", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const saved = await workspace(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      name: "Know exactly what your insurer is asking for.",
    }),
  ).toBeVisible();
  await expect(page.getByLabel(/access token/i)).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /System status: All systems ready/ }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Open claim" }).click();
  await expect(page.getByRole("heading", { name: claim.title })).toBeVisible();
  await expect(page.getByRole("grid")).toBeVisible();
  await page.screenshot({
    path: "test-results/workspace-desktop.png",
    fullPage: true,
  });
  await page.getByLabel("Search documents").fill("discharge");
  await expect(
    page.getByText("Itemized hospital bill.pdf", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Hospital discharge summary.pdf", { exact: true }),
  ).toBeVisible();

  await page.getByRole("tab", { name: /Timeline/ }).click();
  await expect(page.getByText("Admission date: 1 October 2026")).toBeVisible();
  await page.getByRole("tab", { name: /Analyses/ }).click();
  await expect(
    page.getByText("The model connection dropped; resume to continue"),
  ).toBeVisible();
  await page.getByRole("button", { name: /View report/ }).click();

  await expect(
    page.getByRole("heading", { name: "The evidence, explained." }),
  ).toBeVisible();
  await expect(
    page.getByText("Two records disagree on the discharge date."),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/report-desktop.png",
    fullPage: true,
  });

  // A citation opens the source page with the passage highlighted, and closing it leaves the app intact.
  await page
    .getByRole("button", { name: /PROVISIONAL DISCHARGE SUMMARY/ })
    .click();
  await expect(page.getByRole("dialog").locator("mark")).toHaveText(
    "PROVISIONAL DISCHARGE SUMMARY",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "The evidence, explained." }),
  ).toBeVisible();

  await page
    .getByRole("checkbox", {
      name: /Ask the hospital for the final signed discharge summary/,
    })
    .check();
  await expect(page.getByText("1 of 1 done.")).toBeVisible();
  await page
    .getByLabel("Response letter")
    .fill("Dear Claims Team,\n\nEdited by the customer.");
  await page.getByRole("button", { name: "Save edits" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Your edits are saved" }),
  ).toBeVisible();
  expect(saved.map((call) => call.method + " " + call.path)).toEqual([
    "PUT /reports/report-1/checklist",
    "PUT /reports/report-1/draft",
  ]);
  expect(saved[0].body).toEqual({ completed: ["r1"] });
  expect(errors).toEqual([]);
});

test("review desk records a decision only in reviewer mode", async ({
  page,
}) => {
  const saved = await workspace(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/#/review");
  await expect(
    page.getByRole("heading", { name: "The review desk is for reviewers" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Switch to reviewer mode" }).click();
  await expect(
    page.getByRole("heading", { name: "Review desk" }),
  ).toBeVisible();
  await page.getByLabel("Reviewer name").fill("Asha");
  await page.getByRole("gridcell", { name: report.requests[0].text }).click();
  await expect(
    page.getByText("Two records disagree on the discharge date."),
  ).toBeVisible();
  await page.getByLabel("Request evidence").check();
  await page
    .getByRole("textbox", { name: "Reason" })
    .fill("The final summary is still missing from the file.");
  await page.getByRole("button", { name: "Record decision" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Decision recorded" }),
  ).toBeVisible();
  expect(saved.at(-1)).toEqual({
    method: "POST",
    path: "/tasks/" + encodeURIComponent(queueItem.task_id) + "/review",
    body: {
      decision: "request_evidence",
      rationale: "The final summary is still missing from the file.",
      reviewer_name: "Asha",
    },
  });
});

test("mobile layout fits the screen and dialogs manage focus", async ({
  page,
}) => {
  await workspace(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/case/case-1");
  await expect(page.getByRole("heading", { name: claim.title })).toBeVisible();
  await page.screenshot({
    path: "test-results/workspace-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);

  await page.getByRole("button", { name: "Add documents" }).first().click();
  await expect(
    page.getByRole("dialog", { name: "Add documents" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("button", { name: "Start a new claim" }).click();
  await expect(page.getByLabel("Claim name")).toBeFocused();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.getByRole("button", { name: "Terms explained" }).click();
  await page.getByLabel("Search terms").fill("co-pay");
  await expect(page.getByText("Co-payment", { exact: true })).toBeVisible();
  await expect(page.getByText("Itemized bill", { exact: true })).toHaveCount(0);
});
