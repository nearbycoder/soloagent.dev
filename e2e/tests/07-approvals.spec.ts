import { expect, signIn, test } from "./fixtures.ts";

test("the Approvals page loads with its queue, history, and settings", async ({ page }) => {
  await signIn(page);
  await page.goto("/approvals");
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { name: "Approvals", level: 1 })).toBeVisible();
  await expect(main.getByRole("heading", { name: "Waiting", exact: true })).toBeVisible();
  await expect(main.getByRole("heading", { name: "Nothing is waiting" })).toBeVisible();
  await expect(main.getByRole("heading", { name: "Recently decided" })).toBeVisible();
  await expect(main.getByRole("spinbutton", { name: "Timeout (hours)" })).toHaveValue("24");
  await expect(main.getByRole("textbox", { name: "More risky tools" })).toBeVisible();
});
