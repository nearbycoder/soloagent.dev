// Shared behavior: copy buttons, tabs, docs table-of-contents highlighting.
(() => {

  // ---- Copy to clipboard ----
  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch {}
      area.remove();
      return ok;
    }
  };

  const textFor = (button) => {
    if (button.dataset.copy) return button.dataset.copy;
    if (button.dataset.copyTarget) {
      const target = document.getElementById(button.dataset.copyTarget);
      if (target) return target.innerText;
    }
    const pre = button.closest(".code")?.querySelector("pre");
    if (!pre) return "";
    // Shell blocks: copy the commands and their continuation lines, never comments or output.
    if (pre.querySelector(".cmd")) {
      const lines = pre.innerText.split("\n");
      const kept = [];
      let continuing = false;
      for (const raw of lines) {
        const line = raw.replace(/\s+#.*$/, "").trimEnd();
        const isCommand = !raw.trimStart().startsWith("#") && line.trim() !== "";
        if (continuing || (isCommand && !raw.startsWith("  "))) kept.push(continuing ? line : line.trimStart());
        continuing = (continuing || isCommand) && line.endsWith("\\");
      }
      return kept.join("\n");
    }
    return pre.innerText;
  };

  // Screen readers don't reliably announce a button's own label change.
  let status;
  const announce = (message) => {
    if (!status) {
      status = document.createElement("span");
      status.className = "sr-only";
      status.setAttribute("role", "status");
      document.body.appendChild(status);
    }
    status.textContent = "";
    setTimeout(() => (status.textContent = message), 50);
  };

  document.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-copy], [data-copy-target], .copy");
    if (!button) return;
    const text = textFor(button).replace(/\n+$/, "");
    if (!text) return;
    const ok = await copyText(text);
    if (!ok) return;
    announce("Copied to clipboard");
    button.classList.add("copied");
    const label = button.classList.contains("copy") ? button : null;
    const previous = label?.textContent;
    if (label) label.textContent = "copied";
    clearTimeout(button._copyTimer);
    button._copyTimer = setTimeout(() => {
      button.classList.remove("copied");
      if (label) label.textContent = previous;
    }, 1600);
  });

  // ---- Tabs ----
  document.querySelectorAll("[data-tabs]").forEach((root) => {
    const tabs = [...root.querySelectorAll('[role="tab"]')];
    const select = (tab) => {
      for (const t of tabs) {
        const on = t === tab;
        t.setAttribute("aria-selected", String(on));
        t.tabIndex = on ? 0 : -1;
        document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
      }
    };
    root.addEventListener("click", (event) => {
      const tab = event.target.closest('[role="tab"]');
      if (tab) select(tab);
    });
    root.addEventListener("keydown", (event) => {
      const i = tabs.indexOf(document.activeElement);
      if (i < 0) return;
      const step = { ArrowRight: i + 1, ArrowLeft: i - 1 + tabs.length, Home: 0, End: tabs.length - 1 }[event.key];
      if (step === undefined) return;
      event.preventDefault();
      const next = tabs[step % tabs.length];
      select(next);
      next.focus();
    });
  });

  // ---- Docs: highlight the current section in the table of contents ----
  const toc = document.querySelector("[data-toc]");
  if (toc) {
    const links = new Map();
    toc.querySelectorAll('a[href^="#"]').forEach((a) => links.set(a.getAttribute("href").slice(1), a));
    const targets = [...links.keys()].map((id) => document.getElementById(id)).filter(Boolean);
    // The active entry is the last heading scrolled past, so subsections win over their parent.
    let frame = 0;
    const setActive = () => {
      frame = 0;
      let current = targets[0];
      for (const el of targets) if (el.getBoundingClientRect().top <= 120) current = el;
      links.forEach((a, id) => a.classList.toggle("active", id === current?.id));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(setActive);
    };
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    setActive();

    // Close the mobile TOC after picking a section.
    const mobileToc = document.querySelector(".toc-mobile");
    mobileToc?.addEventListener("click", (event) => {
      if (event.target.closest("a")) mobileToc.removeAttribute("open");
    });
  }
})();
