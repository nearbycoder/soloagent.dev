// Animated product demo on the landing page.
// A faux team-chat thread: someone @mentions an agent, a tool call runs, a second agent is
// delegated to, the answer streams in, and a reminder is scheduled. The side panel shows each
// step being committed to the durable log before it appears in the chat.
// With prefers-reduced-motion the final state renders at once, with no animation or looping.
(() => {
  const root = document.getElementById("demo");
  if (!root) return;
  const msgs = root.querySelector("#demo-msgs");
  const log = root.querySelector("#demo-log");
  const replay = root.querySelector("#demo-replay");
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");

  const CANCEL = Symbol("cancel");
  let generation = 0;
  let clock = 0;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const html = (markup) => {
    const t = document.createElement("template");
    t.innerHTML = markup.trim();
    return t.content.firstElementChild;
  };
  const stick = (instant) => {
    msgs.scrollTo({ top: msgs.scrollHeight, behavior: instant ? "auto" : "smooth" });
    log.scrollTop = log.scrollHeight;
  };

  const time = () => {
    const s = 2 + clock++;
    return `09:41:${String(s).padStart(2, "0")}`;
  };

  async function play(instant) {
    const gen = ++generation;
    const wait = async (ms) => {
      if (!instant) await sleep(ms);
      if (gen !== generation) throw CANCEL;
    };
    clock = 0;
    msgs.replaceChildren();
    log.replaceChildren();
    root.classList.remove("fade");

    const commit = (kind, detail, tone = "") => {
      const li = html(
        `<li><span class="ck">✓</span><span class="k ${tone}">${kind}</span><span class="d">${detail}</span></li>`,
      );
      if (instant) li.style.animation = "none";
      li.title = time();
      log.appendChild(li);
      stick(instant);
    };

    const message = ({ name, avatar, color, human, app, via, body }) => {
      const el = html(`
        <div class="m">
          <span class="m-av${human ? " human" : ""}" style="--c:${color || "#8b5cf6"}">${avatar}</span>
          <div class="m-main">
            <div class="m-meta"><b>${name}</b>${app ? '<span class="app">AGENT</span>' : ""}${via ? `<span class="via">${via}</span>` : ""}<time>9:41 AM</time></div>
            <div class="m-body">${body || ""}</div>
          </div>
        </div>`);
      if (instant) el.style.animation = "none";
      msgs.appendChild(el);
      stick(instant);
      return el.querySelector(".m-body");
    };

    const typing = (into) => {
      const el = html('<span class="typing"><i></i><i></i><i></i></span>');
      into.appendChild(el);
      return el;
    };

    const tool = (into, { icon, name, arg, cyan }) => {
      const el = html(`
        <div class="tool${cyan ? " cyan" : ""}">
          <div class="tool-h"><span class="tool-ico">${icon}</span><span class="tn">${name}</span><span class="ta">${arg}</span><span class="ts">running…</span></div>
        </div>`);
      if (instant) el.style.animation = "none";
      into.appendChild(el);
      stick(instant);
      return {
        el,
        done(status, output) {
          const ts = el.querySelector(".ts");
          ts.innerHTML = `✓<span class="lbl"> ${status}</span>`;
          ts.classList.add("done");
          if (output) {
            const out = html(`<div class="tool-out">${output}</div>`);
            if (instant) out.style.animation = "none";
            el.appendChild(out);
          }
          stick(instant);
        },
      };
    };

    const stream = async (into, markup, speed = 34) => {
      const tokens = markup.match(/<(\w+)[^>]*>.*?<\/\1>|\s+|[^\s<]+/g) || [];
      const span = document.createElement("div");
      span.className = "m-text";
      into.appendChild(span);
      if (instant) {
        span.innerHTML = markup;
        stick(true);
        return;
      }
      span.classList.add("cursor");
      let out = "";
      for (const token of tokens) {
        out += token;
        span.innerHTML = out;
        if (token.trim()) {
          stick(false);
          await wait(speed + Math.random() * 30);
        }
      }
      span.classList.remove("cursor");
    };

    // ---- The script ----
    await wait(600);
    commit("inbound", "slack · maya in #eng");
    message({
      name: "Maya",
      avatar: "M",
      human: true,
      body: '<span class="at">@coder</span> CI on main has been red since this morning. What changed?',
    });

    await wait(1000);
    commit("turn", "@coder · claude");
    const coder = message({ name: "coder", avatar: "⌘", color: "#8b5cf6", app: true, via: "Claude Pro/Max" });
    const dots = typing(coder);

    await wait(1200);
    commit("tool", "bash · git log");
    dots.remove();
    const git = tool(coder, { icon: "⚙", name: "bash", arg: "git log --oneline -3 main" });

    await wait(1000);
    commit("result", "bash · 3 lines");
    git.done(
      "0.4s",
      '<span class="hl">a3f91c2</span> build: bump parser to 4.0 (#482)\n<span class="hl">7be0d14</span> docs: refresh README\n<span class="hl">51c2a9e</span> test: flaky retry on ci',
    );

    await wait(1000);
    commit("child", "@coder → @scout", "c");
    const ask = tool(coder, { icon: "⇄", name: "ask_agent", arg: "@scout · did parser 4.0 change its exports?", cyan: true });

    await wait(700);
    commit("turn", "@scout · chatgpt", "c");
    const child = html(`
      <div class="child">
        <span class="m-av" style="--c:#06b6d4">◎</span>
        <div class="m-main">
          <div class="m-meta"><b>scout</b><span class="app">AGENT</span><span class="via">ChatGPT</span></div>
          <div class="m-body"></div>
        </div>
      </div>`);
    if (instant) child.style.animation = "none";
    ask.el.appendChild(child);
    const scout = child.querySelector(".m-body");
    stick(instant);

    await wait(700);
    commit("tool", "web_search", "c");
    const search = tool(scout, { icon: "◍", name: "web_search", arg: "parser 4.0 release notes", cyan: true });

    await wait(1000);
    commit("result", "web_search · 5 hits", "c");
    search.done("0.8s");

    await wait(300);
    commit("turn", "@scout · answer", "c");
    await stream(scout, "Yes. 4.0 removed the default export. Use <code>import { parse }</code> instead.");

    await wait(300);
    commit("return", "@scout → @coder", "c");
    ask.done("2.1s");

    await wait(700);
    commit("turn", "@coder · answer");
    await stream(
      coder,
      'Found it. <code>#482</code> bumped <code>parser</code> to 4.0, which dropped its default export, and <span class="at">@scout</span> confirmed it in the release notes. The fix is one line in <code>build.ts</code>: <code>import { parse } from "parser"</code>.',
    );
    commit("reply", "slack · thread updated");
    const foot = html('<div class="m-foot"><span class="tag v">✓ 12 steps committed</span><span class="tag">2 agents · 2 providers</span></div>');
    if (instant) foot.style.animation = "none";
    coder.appendChild(foot);
    stick(instant);

    await wait(2200);
    commit("inbound", "slack · maya in #eng");
    message({
      name: "Maya",
      avatar: "M",
      human: true,
      body: "Perfect. Remind me Friday at 9 to check if upstream shipped a fix.",
    });

    await wait(1000);
    commit("turn", "@coder · claude");
    const coder2 = message({ name: "coder", avatar: "⌘", color: "#8b5cf6", app: true, via: "Claude Pro/Max" });
    const dots2 = typing(coder2);

    await wait(1000);
    commit("tool", "schedule_reminder");
    dots2.remove();
    const reminder = tool(coder2, { icon: "◷", name: "schedule_reminder", arg: "Fri 09:00 · check parser upstream fix" });

    await wait(800);
    commit("sleep", '<span class="zz">until Fri 09:00</span>');
    reminder.done("scheduled");

    await wait(400);
    commit("turn", "@coder · answer");
    await stream(coder2, "Scheduled. I'll post in this thread Friday at 9:00, even if we redeploy before then.");
    commit("reply", "slack · thread updated");
  }

  async function loop() {
    for (;;) {
      const gen = generation + 1;
      try {
        await play(false);
        await sleep(6000);
        if (gen !== generation) return;
        root.classList.add("fade");
        await sleep(600);
        if (gen !== generation) return;
      } catch (error) {
        if (error === CANCEL) return;
        throw error;
      }
    }
  }

  function start() {
    if (motion.matches) {
      play(true).catch(() => {});
    } else {
      loop();
    }
  }

  replay?.addEventListener("click", start);
  motion.addEventListener?.("change", start);

  if (motion.matches || !("IntersectionObserver" in window)) {
    start();
  } else {
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          start();
        }
      },
      { threshold: 0.25 },
    );
    io.observe(root);
  }
})();
