import { expect, mainNav, test, TOKEN } from "./fixtures.ts";

test("signs in with the admin token", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "soloagent", level: 1 })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Admin token" })).toBeChecked();

  const token = page.getByRole("textbox", { name: "Admin token" });
  await token.fill("not-the-token");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("alert")).toHaveText("That token is not right");

  await token.fill(TOKEN);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(mainNav(page).getByRole("link", { name: "Overview" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your agents at a glance" })).toBeVisible();

  // The session is a cookie: a reload stays signed in.
  await page.reload();
  await expect(mainNav(page)).toBeVisible();
});
