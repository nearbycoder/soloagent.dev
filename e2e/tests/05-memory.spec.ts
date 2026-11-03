import { expect, signIn, test } from "./fixtures.ts";

test("adds, edits, and deletes a memory in an agent's Memory tab", async ({ page }) => {
  await signIn(page);
  await page.goto("/agents");
  await page.getByRole("main").getByRole("button", { name: /^Solo Default agent/ }).click();
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByRole("heading", { name: "Edit Solo" })).toBeVisible();
  await drawer.getByRole("radio", { name: "Memory" }).click();
  await expect(drawer.getByRole("heading", { name: "No memories yet" })).toBeVisible();

  await drawer.getByRole("textbox", { name: "New memory" }).fill("Ann prefers tea");
  await drawer.getByRole("button", { name: "Add memory" }).click();
  const item = drawer.getByRole("listitem").filter({ hasText: "Ann prefers tea" });
  await expect(item).toBeVisible();

  await item.getByRole("button", { name: "Edit memory" }).click();
  await drawer.getByRole("textbox", { name: "Edit memory" }).fill("Ann prefers green tea");
  await drawer.getByRole("button", { name: "Save", exact: true }).click();
  const edited = drawer.getByRole("listitem").filter({ hasText: "Ann prefers green tea" });
  await expect(edited).toBeVisible();

  // Reopening the tab reads it back from the server.
  await drawer.getByRole("radio", { name: "Settings" }).click();
  await drawer.getByRole("radio", { name: "Memory" }).click();
  await expect(edited).toBeVisible();

  await edited.getByRole("button", { name: "Delete memory" }).click();
  await expect(drawer.getByRole("heading", { name: "No memories yet" })).toBeVisible();
  await expect(page.getByText("Memory deleted")).toBeVisible();
});
