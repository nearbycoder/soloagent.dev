// Fingerprints site CSS/JS references (?v=<content hash>) so a new page never loads stale assets.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const site = new URL("../site/", import.meta.url).pathname;
const pages = ["index.html", "docs/index.html"];
const hash = (path) => createHash("sha256").update(readFileSync(join(site, path))).digest("hex").slice(0, 10);

for (const page of pages) {
  const file = join(site, page);
  const html = readFileSync(file, "utf8").replace(/((?:href|src)="\/((?:css|js)\/[^"?]+))(?:\?v=[^"]*)?"/g, (_, attr, path) => `${attr}?v=${hash(path)}"`);
  writeFileSync(file, html);
}
console.log("stamped", pages.join(", "));
