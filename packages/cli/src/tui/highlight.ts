import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { c, italic, type Style } from "./theme.ts";

// The same languages the dashboard highlights.
const LANGUAGES = { bash, css, diff, go, javascript, json, markdown, python, rust, sql, typescript, xml, yaml };
for (const [name, language] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, language);
const ALIASES: Record<string, string> = { sh: "bash", shell: "bash", zsh: "bash", console: "bash", js: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript", py: "python", rs: "rust", yml: "yaml", html: "xml", md: "markdown" };

/** highlight.js scopes → terminal colors, in the dashboard's dark-theme spirit. Built on first use (theme.ts imports this module). */
let scopes: Record<string, Style> | undefined;
const SCOPES = () => (scopes ??= {
  keyword: c.accent,
  built_in: c.cyan,
  type: c.cyan,
  literal: c.yellow,
  number: c.yellow,
  string: c.green,
  regexp: c.green,
  "template-variable": c.green,
  subst: c.muted,
  comment: (t) => italic(c.dim(t)),
  doctag: c.dim,
  meta: c.dim,
  title: c.blue,
  "title.function": c.blue,
  "title.class": c.cyan,
  attr: c.blue,
  attribute: c.blue,
  property: c.blue,
  variable: c.muted,
  params: c.muted,
  symbol: c.yellow,
  addition: c.green,
  deletion: c.red,
  tag: c.blue,
  name: c.blue,
  "selector-tag": c.accent,
  "selector-class": c.blue,
  section: c.accentBright,
  bullet: c.accent,
});

const ENTITIES: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&#x27;": "'", "&#39;": "'" };

/** Code → one colored string per line, or undefined for an unknown language (shown plain). */
export function highlightCode(code: string, lang?: string): string[] | undefined {
  const name = lang ? (ALIASES[lang.toLowerCase()] ?? lang.toLowerCase()) : undefined;
  if (!name || !hljs.getLanguage(name)) return undefined;
  let html: string;
  try {
    html = hljs.highlight(code, { language: name, ignoreIllegals: true }).value;
  } catch {
    return undefined;
  }
  // Walk the span tree; a style applies to each text run, line by line, so wrapping and line splits stay safe.
  const lines: string[] = [""];
  const stack: (Style | undefined)[] = [];
  const style = (text: string) => {
    const s = [...stack].reverse().find(Boolean);
    return s ? s(text) : text;
  };
  for (const part of html.split(/(<span class="[^"]*">|<\/span>)/)) {
    if (!part) continue;
    const open = /^<span class="([^"]*)">$/.exec(part);
    if (open) {
      const scope = open[1]!.split(" ")[0]!.replace(/^hljs-/, "").replace(/_$/, "");
      stack.push(SCOPES()[scope] ?? SCOPES()[scope.split(".")[0]!]);
      continue;
    }
    if (part === "</span>") {
      stack.pop();
      continue;
    }
    const text = part.replace(/&(lt|gt|amp|quot|#x27|#39);/g, (e) => ENTITIES[e] ?? e);
    const chunks = text.split("\n");
    chunks.forEach((chunk, i) => {
      if (i > 0) lines.push("");
      if (chunk) lines[lines.length - 1] += style(chunk);
    });
  }
  return lines;
}
