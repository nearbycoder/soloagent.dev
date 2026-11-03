import { expect, signIn, test } from "./fixtures.ts";

test("starts a chat and the demo model's reply streams in", async ({ page }) => {
  await signIn(page);
  await page.goto("/chat");
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { name: "Chat with Solo" })).toBeVisible();

  const message = main.getByRole("textbox", { name: "Message" });
  const send = main.getByRole("button", { name: "Send" });
  await expect(send).toBeDisabled();
  await message.fill("hello from the e2e suite");
  await send.click();

  await expect(page).toHaveURL(/\/chat\/thr_/);
  await expect(main.getByText("hello from the e2e suite").first()).toBeVisible();
  // The demo model streams a greeting; once it is done the thread shows the whole answer and its usage.
  await expect(main.getByText("and I'll get a real brain.")).toBeVisible();
  await expect(main.getByText("demo/solo-demo")).toBeVisible();
  await expect(main.getByRole("button", { name: "Copy message" })).toBeVisible();
  // The thread list has it, previewing the answer.
  await expect(main.getByRole("link", { name: /hello from the e2e suite.*running on the demo model/ })).toBeVisible();
});
