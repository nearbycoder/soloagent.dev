import { expect, mainNav, signIn, test } from "./fixtures.ts";

test("an invite link makes a member who doesn't see admin pages", async ({ page, browser }) => {
  await signIn(page);
  await page.goto("/team");
  const main = page.getByRole("main");
  await expect(main.getByRole("radio", { name: "Member" })).toBeChecked();
  await main.getByRole("button", { name: "Create invite link" }).click();
  await expect(main.getByText("Invite link for a member")).toBeVisible();
  const link = (await main.locator("code").filter({ hasText: "/invite/" }).textContent())!.trim();
  expect(link).toMatch(/^http:\/\/localhost:\d+\/invite\/[\w-]+$/);

  // The invitee has no session: a fresh browser context.
  const invitee = await browser.newContext();
  try {
    const member = await invitee.newPage();
    await member.goto(link);
    await expect(member.getByRole("heading", { name: "Join your team" })).toBeVisible();
    await member.getByRole("textbox", { name: "Your name" }).fill("Mia");
    await member.getByRole("textbox", { name: "Password", exact: true }).fill("correct horse battery");
    await member.getByRole("textbox", { name: "Confirm password" }).fill("correct horse battery");
    await member.getByRole("button", { name: "Join and sign in" }).click();

    const nav = mainNav(member);
    await expect(nav.getByRole("link", { name: "Overview" })).toBeVisible();
    await expect(member).toHaveURL(/\/$/);
    for (const visible of ["Chat", "Agents", "Activity", "Approvals", "Usage", "Settings"]) {
      await expect(nav.getByRole("link", { name: visible, exact: true })).toBeVisible();
    }
    for (const hidden of ["Providers", "Connections", "Tools", "Team"]) {
      await expect(nav.getByRole("link", { name: hidden, exact: true })).toHaveCount(0);
    }
    const me = (await (await member.request.get("/api/me")).json()) as { actor: { name: string; role: string } };
    expect(me.actor).toMatchObject({ name: "Mia", role: "member" });
    // The link worked once.
    expect((await member.request.get(`/api/invite/${link.split("/").pop()}`)).status()).toBe(410);
  } finally {
    await invitee.close();
  }

  // The admin sees Mia on the team.
  await page.reload();
  await expect(main.getByText("Mia").first()).toBeVisible();
  await expect(main.getByText("No open invites.")).toBeVisible();
});
