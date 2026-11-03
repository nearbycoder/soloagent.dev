import { resolve } from "node:path";
import { expect, signIn, test } from "./fixtures.ts";

const TEST_SERVER = resolve(import.meta.dirname, "../../packages/core/test/mcp-test-server.mjs");

test("adds a stdio MCP server and lists its tools", async ({ page }) => {
  await signIn(page);
  await page.goto("/tools");
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { name: "No MCP servers yet" })).toBeVisible();
  await main.getByRole("button", { name: "Add MCP server" }).first().click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Add an MCP server" })).toBeVisible();
  await expect(dialog.getByRole("radio", { name: "Command (stdio)" })).toBeChecked();
  await dialog.getByRole("textbox", { name: "Name" }).fill("Test server");
  await dialog.getByRole("textbox", { name: "ID" }).fill("testsrv");
  await dialog.getByRole("textbox", { name: "Command" }).fill(process.execPath);
  await dialog.getByRole("textbox", { name: "Arguments" }).fill(TEST_SERVER);
  await dialog.getByRole("button", { name: "Add server" }).click();

  // The editor stays open on the new server and shows what it found.
  await expect(dialog.getByRole("heading", { name: "Test server" })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Tools 4 tools" })).toBeVisible();
  const tools = dialog.getByRole("listitem");
  for (const name of ["echo", "env", "fail", "crash"]) await expect(tools.filter({ has: page.getByText(name, { exact: true }) })).toHaveCount(1);
  await expect(dialog.getByText("Echo the given text back.")).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).first().click();

  await expect(main.getByRole("button", { name: "Test server" })).toBeVisible();
  await expect(main.getByText(/Connected/).first()).toBeVisible();
  await expect(main.getByRole("button", { name: "4 tools" })).toBeVisible();
});
