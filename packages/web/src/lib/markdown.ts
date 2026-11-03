import { Marked, type Tokens } from "marked";
import DOMPurify from "dompurify";
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

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("go", go);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("python", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);
const aliases: Record<string, string> = { sh: "bash", shell: "bash", zsh: "bash", console: "bash", js: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript", py: "python", yml: "yaml", html: "xml", svg: "xml", md: "markdown", rs: "rust" };

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const COPY_ICON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';

const marked = new Marked({ gfm: true, breaks: true });
marked.use({
  renderer: {
    code({ text, lang }: Tokens.Code) {
      const raw = (lang ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      const language = aliases[raw] ?? raw;
      let body: string;
      if (language && hljs.getLanguage(language)) {
        body = hljs.highlight(text, { language, ignoreIllegals: true }).value;
      } else {
        body = escapeHtml(text);
      }
      return `<div class="code-block"><div class="code-head"><span>${escapeHtml(raw || "text")}</span><button type="button" class="code-copy" data-copy-code>${COPY_ICON}<span>Copy</span></button></div><pre><code class="hljs">${body}</code></pre></div>`;
    },
    table(token: Tokens.Table) {
      const head = token.header.map((cell) => `<th${cell.align ? ` style="text-align:${cell.align}"` : ""}>${this.parser.parseInline(cell.tokens)}</th>`).join("");
      const rows = token.rows
        .map((row) => `<tr>${row.map((cell) => `<td${cell.align ? ` style="text-align:${cell.align}"` : ""}>${this.parser.parseInline(cell.tokens)}</td>`).join("")}</tr>`)
        .join("");
      return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
    },
  },
});

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.getAttribute("href")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

const cache = new Map<string, string>();

/** Markdown → sanitized HTML, with highlighted code blocks that carry a copy button. */
export function renderMarkdown(source: string, options: { cache?: boolean } = {}): string {
  const useCache = options.cache !== false;
  const hit = useCache ? cache.get(source) : undefined;
  if (hit !== undefined) return hit;
  const html = DOMPurify.sanitize(marked.parse(source, { async: false }) as string, { ADD_ATTR: ["target", "data-copy-code"] });
  if (useCache && source.length < 20_000) {
    cache.set(source, html);
    if (cache.size > 400) cache.delete(cache.keys().next().value!);
  }
  return html;
}
