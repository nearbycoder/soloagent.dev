/** Markdown dialect conversions for chat platforms. Conservative: code is never touched. */

function mapOutsideCode(markdown: string, transform: (text: string) => string): string {
  return markdown
    .split(/(```[\s\S]*?```|`[^`\n]+`)/g)
    .map((part, index) => (index % 2 === 1 ? part : transform(part)))
    .join("");
}

/** GitHub-flavored markdown to Slack mrkdwn. */
export function toSlack(markdown: string): string {
  return mapOutsideCode(markdown, (text) =>
    text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
      .replace(/\*\*(.+?)\*\*/g, "*$1*")
      .replace(/__(.+?)__/g, "*$1*")
      .replace(/~~(.+?)~~/g, "~$1~")
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "<$2|$1>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>")
      .replace(/^(\s*)[-*]\s+/gm, "$1• "),
  ).replace(/```[a-zA-Z0-9_-]+\n/g, "```\n");
}

/** Markdown to the HTML subset Telegram accepts. */
export function toTelegramHtml(markdown: string): string {
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return markdown
    .split(/(```[\s\S]*?```|`[^`\n]+`)/g)
    .map((part, index) => {
      if (index % 2 === 1) {
        if (part.startsWith("```")) {
          const body = part.replace(/^```[^\n]*\n?/, "").replace(/```$/, "");
          return `<pre>${escape(body)}</pre>`;
        }
        return `<code>${escape(part.slice(1, -1))}</code>`;
      }
      return escape(part)
        .replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>")
        .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
        .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>")
        .replace(/~~(.+?)~~/g, "<s>$1</s>")
        .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>')
        .replace(/^(\s*)[-*]\s+/gm, "$1• ");
    })
    .join("");
}

/** Split text into platform-sized chunks, preferring paragraph and line breaks, never splitting inside a code fence when avoidable. */
export function chunk(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut <= 0) cut = max;
    let head = rest.slice(0, cut);
    rest = rest.slice(cut).replace(/^\s+/, "");
    // Close an open code fence and reopen it in the next chunk.
    if ((head.match(/```/g) ?? []).length % 2 === 1) {
      head += "\n```";
      rest = "```\n" + rest;
    }
    chunks.push(head);
  }
  if (rest) chunks.push(rest);
  return chunks;
}
