// soloagent.dev: copy buttons, tabs, the header, scroll reveals, the hero's agent run, and the docs table of contents.
(() => {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const root = document.documentElement;
  root.classList.add("js");

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
    if (!(await copyText(text))) return;
    announce("Copied to clipboard");
    button.dataset.label ??= button.textContent;
    button.classList.add("copied");
    if (button.classList.contains("copy")) button.textContent = "Copied";
    clearTimeout(button._copyTimer);
    button._copyTimer = setTimeout(() => {
      button.classList.remove("copied");
      if (button.classList.contains("copy")) button.textContent = button.dataset.label;
    }, 1600);
  });

  // ---- Tabs ----
  document.querySelectorAll("[data-tabs]").forEach((tabsRoot) => {
    const tabs = [...tabsRoot.querySelectorAll('[role="tab"]')];
    const select = (tab) => {
      for (const t of tabs) {
        const on = t === tab;
        t.setAttribute("aria-selected", String(on));
        t.tabIndex = on ? 0 : -1;
        document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
      }
      tab.scrollIntoView({ block: "nearest", inline: "nearest" });
    };
    tabsRoot.addEventListener("click", (event) => {
      const tab = event.target.closest('[role="tab"]');
      if (tab) select(tab);
    });
    tabsRoot.addEventListener("keydown", (event) => {
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

  // ---- Header: glass once the page scrolls ----
  const header = document.querySelector("[data-header]");
  if (header) {
    const onScroll = () => header.classList.toggle("scrolled", scrollY > 8);
    addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  // ---- Mobile menu: close on navigation, outside click, or Escape ----
  document.querySelectorAll("details.menu").forEach((menu) => {
    menu.addEventListener("click", (event) => {
      if (event.target.closest("a")) menu.removeAttribute("open");
    });
    document.addEventListener("click", (event) => {
      if (menu.open && !menu.contains(event.target)) menu.removeAttribute("open");
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && menu.open) {
        menu.removeAttribute("open");
        menu.querySelector("summary")?.focus();
      }
    });
  });

  // ---- Reveal on scroll (only for things below the fold, so nothing visible ever blinks) ----
  const revealables = [...document.querySelectorAll("[data-reveal]")];
  document.querySelectorAll(".ledger li").forEach((li, i) => li.style.setProperty("--i", String(i)));
  if (!reduced && "IntersectionObserver" in window && revealables.length) {
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.remove("pre");
          io.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -6% 0px", threshold: 0.06 },
    );
    for (const el of revealables) {
      if (el.getBoundingClientRect().top < innerHeight * 0.94) continue;
      const siblings = [...el.parentElement.children].filter((c) => c.hasAttribute("data-reveal"));
      el.style.transitionDelay = `${(siblings.indexOf(el) % 3) * 80}ms`;
      el.classList.add("pre");
      io.observe(el);
    }
  }

  // ---- The hero's agent run ----
  const run = document.querySelector("[data-run]");
  if (run && !reduced) {
    const $ = (sel) => run.querySelector(sel);
    const part = (name) => run.querySelector(`[data-s="${name}"]`);
    const state = $("[data-state]");
    const stateLabel = $("[data-state-label]");
    const clock = $("[data-clock]");
    const ava = $("[data-ava]");
    const answer = $("[data-stream]");

    // Split the answer into word tokens (inline code stays whole) so it can stream without reflowing.
    const tokens = [];
    const tokenize = (node) => {
      for (const child of [...node.childNodes]) {
        if (child.nodeType === Node.TEXT_NODE) {
          const frag = document.createDocumentFragment();
          for (const piece of child.textContent.split(/(\s+)/)) {
            if (!piece) continue;
            if (/^\s+$/.test(piece)) {
              frag.append(piece);
              continue;
            }
            const span = document.createElement("span");
            span.className = "tok";
            span.textContent = piece;
            frag.append(span);
            tokens.push(span);
          }
          child.replaceWith(frag);
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          if (child.tagName === "CODE") {
            child.classList.add("tok");
            tokens.push(child);
          } else tokenize(child);
        }
      }
    };
    tokenize(answer);

    // Time only advances while the run is on screen and the tab is visible.
    let visible = false;
    let elapsed = 0;
    let clockOn = false;
    const tick = (ms) => {
      if (clockOn) elapsed += ms;
      clock.textContent = `${(elapsed / 1000).toFixed(1)}s`;
    };
    const sleep = async (ms) => {
      let left = ms;
      while (left > 0) {
        const step = Math.min(left, 50);
        await new Promise((r) => setTimeout(r, step));
        if (visible && !document.hidden) {
          left -= step;
          tick(step);
        }
      }
    };
    const setState = (name, label = name) => {
      state.dataset.state = name;
      stateLabel.textContent = label;
    };
    const show = (name) => part(name)?.classList.add("on");
    const start = (name) => {
      const el = part(name);
      el.classList.add("on", "running");
    };
    const finish = (name) => {
      const el = part(name);
      el.classList.remove("running");
      el.classList.add("done");
    };

    const reset = () => {
      run.querySelectorAll("[data-s]").forEach((el) => el.classList.remove("on", "running", "done"));
      tokens.forEach((t) => t.classList.remove("on", "tip"));
      ava.classList.remove("working");
      elapsed = 0;
      clockOn = false;
      tick(0);
      setState("queued");
    };

    const play = async () => {
      reset();
      run.classList.remove("fading");
      await sleep(700);
      clockOn = true;
      setState("running");
      show("agent");
      ava.classList.add("working");
      await sleep(250);
      start("think");
      await sleep(1400);
      finish("think");
      await sleep(300);
      start("bash");
      await sleep(1100);
      finish("bash");
      await sleep(800);
      show("cut");
      ava.classList.remove("working");
      setState("restarting", "restarting");
      await sleep(1300);
      show("resume");
      ava.classList.add("working");
      setState("running", "resumed");
      await sleep(900);
      setState("running");
      start("ask");
      await sleep(1700);
      finish("ask");
      await sleep(350);
      show("answer");
      for (let i = 0; i < tokens.length; i++) {
        tokens[i - 1]?.classList.remove("tip");
        tokens[i].classList.add("on", "tip");
        await sleep(tokens[i].tagName === "CODE" ? 120 : 55);
      }
      await sleep(250);
      show("sql");
      await sleep(500);
      tokens.at(-1)?.classList.remove("tip");
      clockOn = false;
      ava.classList.remove("working");
      setState("done");
      show("foot");
      await sleep(6500);
      run.classList.add("fading");
      await sleep(550);
    };

    const loop = async () => {
      for (;;) await play();
    };

    run.classList.add("anim");
    reset();
    if ("IntersectionObserver" in window) {
      new IntersectionObserver((entries) => (visible = entries.some((e) => e.isIntersecting)), { threshold: 0.2 }).observe(run);
    } else {
      visible = true;
    }
    loop();
  }

  // ---- Docs: highlight the current section in the table of contents ----
  const toc = document.querySelector("[data-toc]");
  if (toc) {
    const links = new Map();
    toc.querySelectorAll('a[href^="#"]').forEach((a) => links.set(a.getAttribute("href").slice(1), a));
    const targets = [...links.keys()].map((id) => document.getElementById(id)).filter(Boolean);
    const list = toc.querySelector("nav");
    let lastId = "";
    // The active entry is the last heading scrolled past, so subsections win over their parent.
    let frame = 0;
    const setActive = () => {
      frame = 0;
      let current = targets[0];
      for (const el of targets) if (el.getBoundingClientRect().top <= 120) current = el;
      if (!current || current.id === lastId) return;
      lastId = current.id;
      links.forEach((a, id) => {
        const on = id === current.id;
        a.classList.toggle("active", on);
        if (on) a.setAttribute("aria-current", "location");
        else a.removeAttribute("aria-current");
      });
      // Keep the active entry in view inside a scrolling sidebar without moving the page.
      const active = links.get(current.id);
      if (list && active && list.scrollHeight > list.clientHeight) {
        const top = active.offsetTop - list.offsetTop;
        if (top < list.scrollTop + 24 || top > list.scrollTop + list.clientHeight - 48) list.scrollTop = top - list.clientHeight / 3;
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(setActive);
    };
    addEventListener("scroll", schedule, { passive: true });
    addEventListener("resize", schedule);
    setActive();

    // Close the mobile TOC after picking a section.
    const mobileToc = document.querySelector(".toc-mobile");
    mobileToc?.addEventListener("click", (event) => {
      if (event.target.closest("a")) mobileToc.removeAttribute("open");
    });
  }
})();
