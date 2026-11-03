import { expect, signIn, test } from "./fixtures.ts";

test("the overview renders stats, setup steps, agents, and activity", async ({ page }) => {
  await signIn(page);
  await page.goto("/");
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { name: "Your agents at a glance", level: 1 })).toBeVisible();
  await expect(main.getByRole("link", { name: /^Agents \d+/ })).toBeVisible();
  await expect(main.getByRole("link", { name: /^Providers 1 configured/ })).toBeVisible();
  await expect(main.getByRole("heading", { name: "Get set up" })).toBeVisible();
  await expect(main.getByRole("heading", { name: "Solo", level: 3 })).toBeVisible();
  await expect(main.getByText("@solo·solo-demo")).toBeVisible();
  await expect(main.getByRole("heading", { name: "Live activity" })).toBeVisible();
  await expect(page.getByRole("status", { name: /^Live/ })).toBeVisible();
});
