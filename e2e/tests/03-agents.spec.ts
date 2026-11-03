import { expect, signIn, test } from "./fixtures.ts";

test("creates an agent in the Agents drawer", async ({ page }) => {
  await signIn(page);
  await page.goto("/agents");
  await page.getByRole("main").getByRole("button", { name: "New agent" }).first().click();

  const drawer = page.getByRole("dialog");
  await expect(drawer.getByRole("heading", { name: "New agent" })).toBeVisible();
  const create = drawer.getByRole("button", { name: "Create agent" });
  await expect(create).toBeDisabled();
  await drawer.getByRole("textbox", { name: "Name" }).fill("Reviewer");
  await drawer.getByRole("textbox", { name: "Handle" }).fill("reviewer");
  await drawer.getByRole("textbox", { name: "Description" }).fill("Reviews pull requests.");
  await drawer.getByRole("textbox", { name: "Instructions" }).fill("You review code carefully.");
  await create.click();

  await expect(drawer).toBeHidden();
  const card = page.getByRole("main").getByRole("button", { name: /^Reviewer .*@reviewer/ });
  await expect(card).toBeVisible();
  await expect(card).toContainText("Reviews pull requests.");
  // The sidebar lists it too, and the API agrees.
  await expect(page.getByRole("complementary").getByRole("link", { name: "Reviewer" })).toBeVisible();
  const agents = (await (await page.request.get("/api/agents")).json()) as { handle: string }[];
  expect(agents.map((a) => a.handle)).toContain("reviewer");
});
