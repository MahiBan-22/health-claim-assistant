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
  // A scan: its one page was read from the image by the model.
  document("doc-2", "Hospital discharge summary.pdf", "clinical", {
    ai_pages: 1,
  }),
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

const step = (id: string, name: string, extra = {}) => ({
  id,
  name,
  kind: "AGENT",
  started_at: "2026-10-10T08:00:05Z",
  duration_ms: 9000,
  running: false,
  interrupted: false,
  outcome: "success",
  model: { calls: 1, duration_ms: 8000, tokens: 1200, running: false },
  tools: [],
  facts: {},
  ...extra,
});
const workflow = {
  run: runs[0],
  recorded: true,
  requests: [
    {
      index: 0,
      text: report.requests[0].text,
      category: "document_request",
      needs_policy: false,
      result: {
        evidence_status: "partially_satisfied",
        submission_status: "not_established",
        review_required: true,
        blocked: false,
        policy_position: null,
      },
    },
  ],
  attempts: [
    {
      id: "root",
      started_at: "2026-10-10T08:00:00Z",
      duration_ms: 64000,
      running: false,
      interrupted: false,
      outcome: "completed",
      facts: { documents: 3 },
      setup: [],
      plan: step("plan", "plan", { facts: { results: 1 } }),
      package: step("package", "claim.package", { kind: "TOOL", model: null }),
      passes: [
        {
          request_index: 0,
          number: 0,
          steps: [
            step("policy-0", "policy", { model: null, duration_ms: 1 }),
            step("evidence-0", "evidence"),
            step("verify-0", "verify", {
              facts: { correction_reason: "unsupported_statements" },
            }),
          ],
        },
        {
          request_index: 0,
          number: 1,
          steps: [
            step("policy-1", "policy", { model: null, duration_ms: 1 }),
            step("evidence-1", "evidence"),
            step("verify-1", "verify", {
              tools: [
                {
                  name: "validate_source_refs",
                  kind: "GUARDRAIL",
                  calls: 1,
                  results: 0,
                  duration_ms: 2,
                  passed: true,
                },
              ],
            }),
          ],
        },
      ],
    },
  ],
  totals: {
    duration_ms: 64000,
    attempts: 1,
    model_calls: 5,
    tokens: 15804,
    tool_calls: 43,
    corrections: 1,
    documents: 3,
  },
};

async function workspace(page: Page) {
  const saved: { method: string; path: string; body: unknown }[] = [];
  await page.route("http://127.0.0.1:8000/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (method !== "GET") {
      let sent: unknown = null;
      try {
        sent = request.postDataJSON?.() ?? null;
      } catch {
        /* A file upload is multipart, not JSON. */
      }
      saved.push({ method, path, body: sent });
    }
    if (path.endsWith("/analysis-events"))
      return route.fulfill({
        contentType: "text/event-stream",
        body: "data: " + JSON.stringify(runs) + "\n\n",
      });
    let body: unknown = {};
    if (path === "/cases") body = [claim];
    else if (path === "/samples") body = [];
    else if (path === "/analyses/run-2/workflow") body = workflow;
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
    else if (path === "/system/model")
      body = {
        connected: true,
        model_available: true,
        model: "gpt-6-luna",
        message: "The AI engine is connected and gpt-6-luna is available.",
      };
    else if (path.endsWith("/documents") && method === "POST")
      body = {
        id: "doc-new",
        kind: "clinical",
        filename: "upload",
        version: 1,
        claim_references: [],
        extraction_status: "extracted",
        ai_pages: 1,
        unread_images: 0,
      };
    else if (path.endsWith("/documents")) body = docs;
    else if (path.endsWith("/documents/doc-2"))
      body = {
        ...docs[1],
        pages: [
          {
            page: 1,
            text: "Hospital: Example\nDocument designation: PROVISIONAL DISCHARGE SUMMARY\nSignature status: unsigned",
            method: "luna",
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
      name: "Less paperwork. More clarity.",
    }),
  ).toBeVisible();
  await expect(page.getByLabel(/access token/i)).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /System status: All systems ready/ }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Open claim" }).click();
  await expect(page.getByRole("heading", { name: claim.title })).toBeVisible();
  await expect(page.getByRole("grid")).toBeVisible();
  await expect(page.getByText("Read by AI", { exact: true })).toHaveCount(1);
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
  await expect(
    page.getByRole("dialog").getByText(/Read by AI: text on this page/),
  ).toBeVisible();
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

test("documents are added as PDF, Word or text, and an older .doc is refused", async ({
  page,
}) => {
  const saved = await workspace(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/#/case/case-1");
  await page.getByRole("button", { name: "Add documents" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add documents" });
  await expect(
    dialog.getByText(/pictures inside Word files are read by the AI model/),
  ).toBeVisible();
  const file = (name: string) => ({
    name,
    mimeType: "application/octet-stream",
    buffer: Buffer.from("fictional"),
  });
  await dialog
    .getByLabel("Choose files")
    .setInputFiles([file("letter.docx"), file("scan.PDF"), file("old.doc")]);
  await expect(
    page.getByRole("alert").filter({ hasText: "Save an older .doc file" }),
  ).toBeVisible();
  await expect(dialog.getByText("letter.docx")).toBeVisible();
  await expect(dialog.getByText("old.doc")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Add 2 documents" }).click();
  await expect(
    page.getByRole("status").filter({
      hasText:
        "2 documents added and sorted into categories. 2 scanned pages were read by AI",
    }),
  ).toBeVisible();
  expect(saved.map((call) => call.method + " " + call.path)).toEqual([
    "POST /cases/case-1/documents",
    "POST /cases/case-1/documents",
  ]);
});

test("workflow chart shows each step, and the landing page stands without the sidebar", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await workspace(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/#/case/case-1");
  await page.getByRole("tab", { name: /Analyses/ }).click();
  await page.getByRole("button", { name: "Workflow" }).first().click();

  await expect(
    page.getByRole("heading", { name: "How this analysis ran" }),
  ).toBeVisible();
  await expect(page.getByText("15,804")).toBeVisible();
  const point = page.getByRole("region", { name: "Point 1" });
  await expect(point.getByText("Planner")).toHaveCount(0);
  await expect(point.getByText("Evidence agent")).toHaveCount(2);
  await expect(point.getByText("Correction loop.")).toBeVisible();
  await expect(
    point.getByText(
      "Not needed: this point does not depend on policy wording.",
    ),
  ).toHaveCount(2);
  await expect(point.getByText("Sent to review")).toBeVisible();
  // A step opens to show what it did.
  await point
    .getByRole("button", { name: /Verifier/ })
    .last()
    .click();
  await expect(
    point.getByText("Checked each citation word for word: passed"),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/workflow-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: /Open report/ }).click();
  await expect(
    page.getByRole("heading", { name: "The evidence, explained." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "How this was produced" }).click();
  await expect(
    page.getByRole("heading", { name: "How this analysis ran" }),
  ).toBeVisible();

  // The sidebar's "My claims" opens the landing page at the claim list, and the sidebar stays behind.
  const sidebar = page.getByRole("navigation", { name: "Main navigation" });
  await sidebar.getByRole("button", { name: "My claims" }).click();
  await expect(
    page.getByRole("heading", { name: "Pick up where you left off" }),
  ).toBeInViewport();
  await expect(sidebar).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open menu" })).toHaveCount(0);
  for (const removed of [
    "How the required tools are used",
    "What the agents demonstrate",
    "Core stack",
  ])
    await expect(page.getByText(removed)).toHaveCount(0);
  await page.getByRole("button", { name: "Open claim" }).click();
  await expect(sidebar).toBeVisible();
  expect(errors).toEqual([]);
});

test("the AI engine is reported by the server and never signed in to from the browser", async ({
  page,
}) => {
  const saved = await workspace(page);
  const requested: string[] = [];
  page.on("request", (request) =>
    requested.push(new URL(request.url()).pathname),
  );
  await page.route("http://127.0.0.1:8000/system/model", (route) =>
    route.fulfill({
      json: {
        connected: false,
        model_available: false,
        model: "gpt-6-luna",
        message:
          "The AI engine is signed out on the server. An administrator needs to run codex login there.",
      },
    }),
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/#/case/case-1");
  await expect(page.getByRole("heading", { name: claim.title })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "The AI engine is not available" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Run analysis" }),
  ).toBeDisabled();

  await page.getByRole("button", { name: "See AI engine status" }).click();
  const dialog = page.getByRole("dialog", { name: "AI analysis engine" });
  await expect(dialog.getByText(/signed out on the server/)).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Check again" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /ChatGPT|Sign in|Disconnect/i }),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "Check again" }).click();
  await expect(dialog.getByText(/signed out on the server/)).toBeVisible();
  expect(requested.filter((path) => path.startsWith("/auth/"))).toEqual([]);
  expect(saved).toEqual([]);
});
