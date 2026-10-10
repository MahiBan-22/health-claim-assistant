import { test, expect } from "@playwright/test";
const claim = {
  id: "case-1",
  title: "Hospitalization reimbursement",
  claim_reference: "CLM-2026-0142",
};
const docs = [
  {
    id: "doc-1",
    logical_id: "letter",
    filename: "Insurer clarification request.pdf",
    kind: "insurer_communication",
    version: 1,
    extraction_status: "ready",
  },
  {
    id: "doc-2",
    logical_id: "clinical",
    filename: "Hospital discharge summary.pdf",
    kind: "clinical",
    version: 1,
    extraction_status: "ready",
  },
  {
    id: "doc-3",
    logical_id: "bill",
    filename: "Itemized hospital bill.pdf",
    kind: "bill",
    version: 2,
    extraction_status: "ready",
  },
  {
    id: "doc-4",
    logical_id: "policy",
    filename: "Health insurance policy.pdf",
    kind: "policy",
    version: 1,
    extraction_status: "ready",
  },
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
    error: "Additional evidence is required before continuing.",
    report_id: null,
  },
];
const report = {
  id: "report-1",
  case_id: claim.id,
  run_id: "run-2",
  version: 1,
  model: "gpt-6-luna",
  review_required: true,
  requests: [
    {
      request_id: "request-1",
      text: "Provide the discharge summary and itemized hospital expenses.",
    },
  ],
  findings: [
    {
      request_id: "request-1",
      evidence_status: "supported",
      submission_status: "not_confirmed",
      explanation:
        "The discharge summary documents the admission and treatment. The itemized bill provides a breakdown of the hospital expenses, with dates matching the clinical record.",
      evidence_refs: [
        {
          document_id: "doc-2",
          version: 1,
          page: 1,
          quote: "Patient was discharged following completion of treatment.",
        },
      ],
      policy_refs: [],
      receipt_refs: [],
      unresolved_questions: [
        "Has the insurer acknowledged receipt of the final bill?",
      ],
      next_action:
        "Submit the discharge summary and itemized bill together, and retain the acknowledgement.",
      review_required: true,
    },
  ],
  response_draft:
    "Dear Claims Team,\n\nPlease find the discharge summary and itemized hospital bill supporting this claim. Kindly confirm receipt of these documents.",
  attachment_manifest: [],
};
test.beforeEach(async ({ page }) => {
  await page.route("http://127.0.0.1:8000/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    let body: unknown = {};
    if (path === "/cases") body = [claim];
    else if (path.endsWith("/analysis-events"))
      return route.fulfill({
        contentType: "text/event-stream",
        body: "data: " + JSON.stringify(runs) + "\n\n",
      });
    else if (path.endsWith("/documents")) body = docs;
    else if (path === "/auth/chatgpt/status")
      body = {
        connected: true,
        storage_available: true,
        email: "test@example.test",
      };
    else if (path === "/auth/chatgpt/models")
      body = { selected_model_available: true };
    else if (path === "/reports/report-1") body = report;
    else if (path.endsWith("/pages/1"))
      body = {
        text: "Patient was discharged following completion of treatment. The clinical record includes the admission and discharge dates.",
      };
    await route.fulfill({ json: body });
  });
  await page.goto("/");
  await page.getByLabel("Workspace access token").fill("test-only-token");
  await page
    .getByRole("button", { name: "Open workspace", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: claim.title })).toBeVisible();
});
test("evidence search, history, report, citations and review", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1050 });
  await expect(page.getByRole("grid")).toBeVisible();
  await expect(
    page.getByText("Hospital discharge summary.pdf", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/workspace-desktop.png",
    fullPage: true,
  });
  await page.getByLabel("Search evidence").fill("discharge");
  await expect(
    page.getByText("Itemized hospital bill.pdf", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("tab", { name: "Analysis history" }).click();
  await expect(
    page.getByRole("button", { name: "View report", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "View report", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "The evidence, explained." }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/report-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: /Source 1/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Review queue", exact: true }).click();
  await page
    .getByLabel("Rationale")
    .fill("The provided source documents support the finding.");
  await page.getByRole("button", { name: "Record review" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Reviewer decision saved" }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
test("mobile layout and accessible dialogs", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "test-results/workspace-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Add evidence", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByLabel("Document category")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "New case", exact: true }).click();
  await expect(page.getByLabel("Case title")).toBeFocused();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "New case", exact: true }),
  ).toBeFocused();
});
