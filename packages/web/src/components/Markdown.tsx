import { memo, useCallback } from "react";
import { renderMarkdown } from "../lib/markdown.ts";
import { copyText } from "../lib/clipboard.ts";
import { cn } from "../lib/cn.ts";

/** Sanitized markdown with copy buttons on code blocks (handled by event delegation). */
export const Markdown = memo(function Markdown({ text, className, live, small }: { text: string; className?: string; live?: boolean; small?: boolean }) {
  const onClick = useCallback(async (event: React.MouseEvent<HTMLDivElement>) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-copy-code]");
    if (!button) return;
    const code = button.closest(".code-block")?.querySelector("code")?.textContent ?? "";
    if (await copyText(code)) {
      const label = button.querySelector("span");
      button.setAttribute("data-copied", "");
      if (label) label.textContent = "Copied";
      setTimeout(() => {
        button.removeAttribute("data-copied");
        if (label) label.textContent = "Copy";
      }, 1400);
    }
  }, []);
  return (
    <div
      className={cn("prose", small && "prose-sm", live && "caret-host", className)}
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: renderMarkdown(text, { cache: !live }) }}
    />
  );
});
