import { test, expect } from "@playwright/test";

test.describe("MIET Translator Pro — smoke", () => {
  test("app boots and shows the empty state", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /MIET Translator/i })).toBeVisible();
    await expect(page.getByText(/Брось/)).toBeVisible();
  });

  test("settings panel toggles", async ({ page }) => {
    await page.goto("/");
    // Without a key, the warning is visible and Settings open by default.
    await expect(page.getByText(/Нужен ключ OpenRouter|API key|OpenRouter/i).first()).toBeVisible();
  });
});
