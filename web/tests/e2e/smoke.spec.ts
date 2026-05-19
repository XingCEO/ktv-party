import { expect, test } from "@playwright/test";

test("landing page lists rooms from the API", async ({ page }) => {
  await page.route("**/api/rooms", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }

    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify([
        {
          id: "smoke-room",
          name: "Smoke Room",
          created_at: 1,
          timer_started_at: null,
          rate_per_minute: 8,
        },
      ]),
    });
  });

  await page.goto("/");

  await expect(page.getByRole("heading", { name: /KTV Box/i })).toBeVisible();
  await expect(page.getByText("Smoke Room")).toBeVisible();
  await expect(page.locator('a[href="/tv/smoke-room"]')).toBeVisible();
  await expect(page.locator('a[href="/m/smoke-room"]')).toBeVisible();
});
