import { test as base, expect, type Page } from "@playwright/test";

export const TOKEN = "e2e-token";

/** Every page talks to the server global-setup.ts started. */
export const test = base.extend({
  baseURL: async ({}, use) => {
    const url = process.env.SOLOAGENT_E2E_URL;
    if (!url) throw new Error("SOLOAGENT_E2E_URL is not set: run through playwright.config.ts");
    await use(url);
  },
});

export { expect };

/** Sign in as the admin without the form (the login spec covers the form). */
export async function signIn(page: Page) {
  const response = await page.request.post("/api/session", { data: { token: TOKEN } });
  expect(response.ok()).toBe(true);
}

export const mainNav = (page: Page) => page.getByRole("navigation", { name: "Main" });
