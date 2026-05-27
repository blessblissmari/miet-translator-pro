import { test, expect } from "@playwright/test";

test.describe("MIET Translator Pro — smoke", () => {
  test("app boots and shows the empty state", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /MIET Translator/i })).toBeVisible();
    // Dropzone copy contains "Брось" — present regardless of key state.
    await expect(page.getByText(/Брось/).first()).toBeVisible();
  });

  test("settings panel is reachable and key field is rendered", async ({ page }) => {
    await page.goto("/");
    // "MiMo (Xiaomi) API key" label is in the SettingsPanel.
    await expect(page.getByText(/MiMo \(Xiaomi\) API key/i)).toBeVisible();
    // mimo- placeholder hints that the input is present.
    await expect(page.getByPlaceholder(/mimo-/i)).toBeVisible();
  });
});
