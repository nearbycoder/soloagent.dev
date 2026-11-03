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
    return pre ? pre.innerText : "";
  };

  document.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-copy], [data-copy-target], .copy");
    if (!button) return;
    const text = textFor(button).replace(/\n+$/, "");
    if (!text) return;
    const ok = await copyText(text);
    if (!ok) return;
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
      if (i < 0 || (event.key !== "ArrowRight" && event.key !== "ArrowLeft")) return;
      const next = tabs[(i + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
      select(next);
      next.focus();
    });
  });

  // ---- Docs: highlight the current section in the table of contents ----
  const toc = document.querySelector("[data-toc]");
  if (toc && "IntersectionObserver" in window) {
    const links = new Map();
    toc.querySelectorAll('a[href^="#"]').forEach((a) => links.set(a.getAttribute("href").slice(1), a));
    const sections = [...links.keys()].map((id) => document.getElementById(id)).filter(Boolean);
    const visible = new Set();
    const setActive = () => {
      const current = sections.find((s) => visible.has(s.id)) ?? null;
      if (!current) return;
      links.forEach((a, id) => a.classList.toggle("active", id === current.id));
    };
    const spy = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        setActive();
      },
      { rootMargin: "-80px 0px -60% 0px" },
    );
    sections.forEach((s) => spy.observe(s));

    // Close the mobile TOC after picking a section.
    const mobileToc = document.querySelector(".toc-mobile");
    mobileToc?.addEventListener("click", (event) => {
      if (event.target.closest("a")) mobileToc.removeAttribute("open");
    });
  }
})();
