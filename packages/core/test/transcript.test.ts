import { test } from "node:test";
import assert from "node:assert/strict";
import { plainPreview } from "../src/transcript.ts";

test("previews are one plain line: no code, table rules, headings, emphasis, or link syntax", () => {
  const markdown = "## Plan\n\n| Task | Owner |\n| --- | --- |\n| Ship **it** | Eng |\n\n```ts\nconst x = 1;\n```\n\nSee [the docs](https://x) and run `npm test`.";
  assert.equal(plainPreview(markdown), "Plan Task Owner Ship it Eng See the docs and run npm test.");
  assert.equal(plainPreview("keep snake_case_names, but _drop_ emphasis"), "keep snake_case_names, but drop emphasis");
  assert.equal(plainPreview("x".repeat(200), 10), `${"x".repeat(9)}…`);
});
