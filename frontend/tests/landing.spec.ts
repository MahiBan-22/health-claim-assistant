import { expect, test, type Page } from "@playwright/test";

const customer = {
  claims: 3,
  documents: 14,
  cases_analyzed: 2,
  points_checked: 8,
  supported_points: 4,
  needs_review: 2,
  evidence_gaps: 3,
  cited_points: 6,
  receipts_confirmed: 1,
  policy_points: 2,
  timed_reports: 2,
  analysis_seconds: 180,
  report_seconds: [60, 120],
};
const empty = Object.fromEntries(
  Object.entries(customer).map(([key]) => [
    key,
    key === "report_seconds" ? [] : 0,
  ]),
);

async function landing(
  page: Page,
  impact: unknown = { customer, samples: empty },
) {
  await page.route("http://127.0.0.1:8000/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/business/impact") return route.fulfill({ json: impact });
    if (path === "/cases" || path === "/samples")
      return route.fulfill({ json: [] });
    if (path === "/system/status")
      return route.fulfill({
        json: {
          api: true,
          database: true,
          redis: true,
          workers: 1,
          queued: 0,
          counts: {
            cases: 0,
            documents: 0,
            reports: 0,
            analyses: 0,
            active: 0,
          },
        },
      });
    return route.fulfill({ json: { connected: false } });
  });
  await page.goto("/");
}

test("landing explains agent outputs and calculates transparent impact estimates", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await landing(page);
  await expect(
    page.getByRole("heading", { name: "Less paperwork. More clarity." }),
  ).toBeVisible();
  // The landing page stands alone: no workspace sidebar, and the hackathon sections are gone.
  await expect(
    page.getByRole("navigation", { name: "Main navigation" }),
  ).toHaveCount(0);
  await expect(page.getByText("How the required tools are used")).toHaveCount(
    0,
  );
  const reading = page.getByRole("region", {
    name: "Any document in. Exact words out.",
  });
  await expect(reading.getByText("Word (.docx)")).toBeVisible();
  await expect(
    reading.getByRole("heading", { name: "Read by the AI model" }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "On this page" })
    .getByRole("button", { name: "Impact" })
    .click();
  const impact = page.getByRole("region", {
    name: "Less guesswork. Measurable progress.",
  });
  await expect(impact.getByRole("heading", { level: 2 })).toBeInViewport();
  await expect(
    impact.getByRole("meter", { name: "Fully supported" }),
  ).toHaveAttribute("aria-valuenow", "4");
  await expect(impact.getByText("1.4 hrs", { exact: true })).toBeVisible();
  await expect(impact.getByText("75%", { exact: true })).toBeVisible();
  await page.getByLabel("Manual review per claim").focus();
  await page.keyboard.press("ArrowLeft");
  await expect(impact.getByText("1.3 hrs", { exact: true })).toBeVisible();
  await impact
    .getByRole("button", { name: "Sample cases", exact: true })
    .click();
  await expect(impact.getByText("Fictional sample activity")).toBeVisible();
  await expect(impact.getByText("Not measured yet")).toBeVisible();
  await expect(
    impact.getByText(
      "Open a sample below and run an analysis to see its metrics here.",
    ),
  ).toBeVisible();
  await impact
    .getByRole("button", { name: "Your claims", exact: true })
    .click();
  await page.getByRole("button", { name: /Policy agent.*Decodes/ }).click();
  await expect(page.locator("#agent-detail")).toContainText(
    "A cited policy position",
  );
  await page
    .getByRole("button", { name: /Verifier.*Checks the answer/ })
    .click();
  await expect(page.locator("#agent-detail")).toContainText(
    "withheld unsupported wording",
  );
  await page.getByText("How we measure impact", { exact: true }).click();
  await expect(
    page.getByText(/Claim settlements, unique customers/),
  ).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "test-results/landing-desktop.png",
    fullPage: true,
  });
  await page.screenshot({ path: "test-results/landing-hero.png" });
  expect(errors).toEqual([]);
});

test("landing fits small screens and the primary action opens claim creation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await landing(page, { customer: empty, samples: empty });
  await expect(
    page.getByText(/Your impact starts with your first analysis/),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/landing-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "Start a new claim", exact: true })
    .last()
    .click();
  await expect(page.getByLabel("Claim name")).toBeFocused();
  await page.keyboard.press("Escape");
  for (const width of [360, 768, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
});

test("the footer takes a name and email for questions about the application", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await landing(page);
  const sent: unknown[] = [];
  let refuse = true;
  await page.route("http://127.0.0.1:8000/inquiries", (route) => {
    sent.push(route.request().postDataJSON());
    return refuse
      ? route.fulfill({ status: 422, json: { detail: [{ msg: "invalid" }] } })
      : route.fulfill({ status: 201, json: { saved: true } });
  });
  const contact = page.getByRole("region", {
    name: "Ask us anything. We’ll get back to you.",
  });
  await contact.getByLabel("Your name").fill("  Asha Rao ");
  await contact.getByLabel("Email address").fill("asha@example.test");
  await contact.getByRole("button", { name: "Ask a question" }).click();
  await expect(contact.getByRole("alert")).toContainText(
    "Check the name and email address",
  );
  refuse = false;
  await contact.getByRole("button", { name: "Ask a question" }).click();
  await expect(contact.getByRole("status")).toContainText(
    "Thank you, Asha Rao.",
  );
  await expect(contact.getByRole("status")).toContainText("asha@example.test");
  expect(sent.at(-1)).toEqual({ name: "Asha Rao", email: "asha@example.test" });
  await page.screenshot({ path: "test-results/landing-contact.png" });
  // The footer reaches the parts of the workspace the sidebar used to.
  await page.getByRole("button", { name: "Review desk" }).click();
  await expect(
    page.getByRole("navigation", { name: "Main navigation" }),
  ).toBeVisible();
});

test("metrics failures show a retry instead of invented zeros", async ({
  page,
}) => {
  await landing(page, {});
  await expect(page.getByText(/Impact metrics are unavailable/)).toBeVisible();
  await page.route("http://127.0.0.1:8000/business/impact", (route) =>
    route.fulfill({ json: { customer, samples: empty } }),
  );
  await page.getByRole("button", { name: "Retry metrics" }).click();
  await expect(page.getByText("75%", { exact: true })).toBeVisible();
});
