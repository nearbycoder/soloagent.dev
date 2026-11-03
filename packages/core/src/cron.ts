/**
 * A small 5-field cron parser and next-run calculator, timezone- and DST-aware through
 * `Intl.DateTimeFormat`. No dependencies.
 *
 *   ┌──────── minute        0-59
 *   │ ┌────── hour          0-23
 *   │ │ ┌──── day of month  1-31
 *   │ │ │ ┌── month         1-12 or jan-dec
 *   │ │ │ │ ┌ day of week   0-7 or sun-sat (0 and 7 are Sunday)
 *   * * * * *
 *
 * Each field takes `*`, numbers, names, lists (`1,15`), ranges (`1-5`, `mon-fri`), and steps (`*／15`,
 * `0-30/10`, `5/15`). As in classic cron, when both day fields are restricted a day matches either one.
 * Macros: `@hourly`, `@daily`/`@midnight`, `@weekly`, `@monthly`, `@yearly`/`@annually`.
 *
 * Daylight saving: a wall time that a spring-forward jump skips fires once, right after the jump; a wall
 * time that a fall-back repeats fires once, on its first occurrence.
 */
import type { AutomationPreset } from "@soloagent/client";

export type Cron = {
  source: string;
  minutes: number[];
  hours: number[];
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  /** The day-of-month field was `*` (or a step over all days). */
  anyDay: boolean;
  /** The day-of-week field was `*`. */
  anyWeekday: boolean;
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

export class CronError extends Error {}

export function parseCron(expression: string): Cron {
  const source = expression.trim().replace(/\s+/g, " ");
  const expanded = MACROS[source.toLowerCase()] ?? source;
  const parts = expanded.split(" ");
  if (parts.length !== 5) throw new CronError(`A cron expression has 5 fields (minute hour day month weekday); got ${parts.length}: "${source}"`);
  const [m, h, dom, mon, dow] = parts as [string, string, string, string, string];
  const weekdays = new Set(field(dow, 0, 7, WEEKDAYS, "day of week").map((d) => (d === 7 ? 0 : d)));
  return {
    source,
    minutes: field(m, 0, 59, undefined, "minute"),
    hours: field(h, 0, 23, undefined, "hour"),
    days: new Set(field(dom, 1, 31, undefined, "day of month")),
    months: new Set(field(mon, 1, 12, MONTHS, "month")),
    weekdays,
    anyDay: dom === "*" || dom === "?",
    anyWeekday: dow === "*" || dow === "?",
  };
}

/** Whether `expression` parses; returns the error message otherwise. */
export function cronError(expression: string): string | undefined {
  try {
    parseCron(expression);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function field(text: string, min: number, max: number, names: string[] | undefined, label: string): number[] {
  const values = new Set<number>();
  for (const item of text.toLowerCase().split(",")) {
    if (!item) throw new CronError(`Empty item in the ${label} field`);
    const [range, stepText, extra] = item.split("/");
    if (extra !== undefined) throw new CronError(`Bad step in the ${label} field: "${item}"`);
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new CronError(`Bad step in the ${label} field: "${item}"`);
    let lo: number;
    let hi: number;
    if (range === "*" || range === "?") {
      lo = min;
      hi = max === 7 ? 6 : max; // `*` in day-of-week is 0-6
    } else if (range!.includes("-")) {
      const [a, b] = range!.split("-");
      lo = value(a!, min, max, names, label);
      hi = value(b!, min, max, names, label);
      if (hi < lo) throw new CronError(`Backwards range in the ${label} field: "${item}"`);
    } else {
      lo = value(range!, min, max, names, label);
      // "5/15" means from 5 to the end, every 15.
      hi = stepText === undefined ? lo : max === 7 ? 6 : max;
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return [...values].sort((a, b) => a - b);
}

function value(text: string, min: number, max: number, names: string[] | undefined, label: string): number {
  const named = names?.indexOf(text.slice(0, 3));
  if (names && named !== undefined && named >= 0 && /^[a-z]+$/.test(text)) return names === MONTHS ? named + 1 : named;
  if (!/^\d+$/.test(text)) throw new CronError(`Unknown value in the ${label} field: "${text}"`);
  const n = Number(text);
  if (n < min || n > max) throw new CronError(`${label[0]!.toUpperCase()}${label.slice(1)} ${n} is out of range (${min}-${max})`);
  return n;
}

// ───────────────────────────── time zones ─────────────────────────────

type Wall = { year: number; month: number; day: number; hour: number; minute: number };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Whether `timeZone` is an IANA zone this runtime knows. */
export function isTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The server's own zone. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** Wall clock time of an instant in a zone. */
export function wallTime(at: number, timeZone: string): Wall & { second: number } {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(at)) if (part.type !== "literal") parts[part.type] = Number(part.value);
  return { year: parts.year!, month: parts.month!, day: parts.day!, hour: parts.hour! % 24, minute: parts.minute!, second: parts.second! };
}

/** Offset of a zone from UTC at an instant, in ms (wall − UTC). */
function offsetAt(at: number, timeZone: string): number {
  const w = wallTime(at, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - (at - (((at % 1000) + 1000) % 1000));
}

const sameWall = (a: Wall, b: Wall) => a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute;

/**
 * The instant a wall clock time happens in a zone: its first occurrence when a fall-back repeats it, or
 * the moment of the jump when a spring-forward skips it.
 */
export function zonedInstant(wall: Wall, timeZone: string): number {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  const before = offsetAt(naive - 30 * 3_600_000, timeZone);
  const after = offsetAt(naive + 30 * 3_600_000, timeZone);
  const candidates = [...new Set([naive - before, naive - after])].sort((a, b) => a - b);
  for (const at of candidates) if (sameWall(wallTime(at, timeZone), wall)) return at;
  // Skipped by a jump forward: find the first minute after the gap.
  let lo = Math.min(...candidates);
  let hi = Math.max(...candidates);
  while (hi - lo > 60_000) {
    const mid = lo + Math.floor((hi - lo) / 120_000) * 60_000;
    if (offsetAt(mid, timeZone) === before) lo = mid;
    else hi = mid;
  }
  return hi;
}

// ───────────────────────────── next runs ─────────────────────────────

const HORIZON_DAYS = 366 * 5;

/** The first fire time strictly after `after`, or undefined when the expression never fires (e.g. Feb 30). */
export function nextRun(cron: Cron | string, timeZone: string, after: number): number | undefined {
  const c = typeof cron === "string" ? parseCron(cron) : cron;
  const start = wallTime(after, timeZone);
  // Walk calendar days in the zone, using UTC math for pure date arithmetic.
  let day = Date.UTC(start.year, start.month - 1, start.day);
  for (let i = 0; i <= HORIZON_DAYS; i++, day += 86_400_000) {
    const date = new Date(day);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const dom = date.getUTCDate();
    if (!c.months.has(month)) continue;
    const domHit = c.days.has(dom);
    const dowHit = c.weekdays.has(date.getUTCDay());
    const dayHit = c.anyDay && c.anyWeekday ? true : c.anyDay ? dowHit : c.anyWeekday ? domHit : domHit || dowHit;
    if (!dayHit) continue;
    for (const hour of c.hours) {
      if (i === 0 && hour < start.hour) continue;
      for (const minute of c.minutes) {
        if (i === 0 && hour === start.hour && minute < start.minute) continue;
        const at = zonedInstant({ year, month, day: dom, hour, minute }, timeZone);
        if (at > after) return at;
      }
    }
  }
  return undefined;
}

/** The next `count` fire times after `after`. */
export function nextRuns(cron: Cron | string, timeZone: string, after: number, count: number): number[] {
  const c = typeof cron === "string" ? parseCron(cron) : cron;
  const out: number[] = [];
  let cursor = after;
  while (out.length < count) {
    const next = nextRun(c, timeZone, cursor);
    if (next === undefined) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

// ───────────────────────────── presets ─────────────────────────────

export type SchedulePreset = AutomationPreset;

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function hm(time: string): [number, number] {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(time.trim());
  if (!match) throw new CronError(`Use a time like 09:00 or 5:30pm; got "${time}"`);
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const meridiem = match[3]?.toLowerCase();
  if (meridiem) {
    if (hour < 1 || hour > 12) throw new CronError(`Bad time "${time}"`);
    hour = (hour % 12) + (meridiem === "pm" ? 12 : 0);
  }
  if (hour > 23 || minute > 59) throw new CronError(`Bad time "${time}"`);
  return [hour, minute];
}

/** A preset as the cron expression it is stored as. */
export function presetToCron(preset: SchedulePreset): string {
  switch (preset.kind) {
    case "minutes": {
      if (!Number.isInteger(preset.every) || preset.every < 1 || preset.every > 59) throw new CronError("Every N minutes takes N from 1 to 59");
      return preset.every === 1 ? "* * * * *" : `*/${preset.every} * * * *`;
    }
    case "hours": {
      if (!Number.isInteger(preset.every) || preset.every < 1 || preset.every > 23) throw new CronError("Every N hours takes N from 1 to 23");
      return preset.every === 1 ? "0 * * * *" : `0 */${preset.every} * * *`;
    }
    case "daily": {
      const [h, m] = hm(preset.time);
      return `${m} ${h} * * *`;
    }
    case "weekdays": {
      const [h, m] = hm(preset.time);
      return `${m} ${h} * * 1-5`;
    }
    case "weekly": {
      if (!Number.isInteger(preset.day) || preset.day < 0 || preset.day > 6) throw new CronError("Weekly takes a day from 0 (Sunday) to 6 (Saturday)");
      const [h, m] = hm(preset.time);
      return `${m} ${h} * * ${preset.day}`;
    }
  }
}

/**
 * Parse a schedule written as cron or as a short phrase: "every 15 minutes", "every 2 hours", "hourly",
 * "daily at 9:00", "every day at 17:30", "weekdays at 9am", "mondays at 09:30", "every friday at 4pm".
 * Returns the cron expression.
 */
export function parseSchedule(text: string): string {
  const s = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (!s) throw new CronError("A schedule is required");
  // Cron: five fields whose minute and hour fields are numeric (names only appear in the day fields).
  if (s.startsWith("@") || /^[\d*?,\-/]+ [\d*?,\-/]+( [\d*?,\-/a-z]+){3}$/.test(s)) {
    const parsed = parseCron(s);
    return parsed.source;
  }
  let match = /^every (\d+)? ?(minute|min|hour)s?$/.exec(s);
  if (match) return presetToCron({ kind: match[2] === "hour" ? "hours" : "minutes", every: Number(match[1] ?? 1) });
  if (s === "hourly") return "0 * * * *";
  const at = /(?: at)? (\d{1,2}(?::\d{2})? ?(?:am|pm)?)$/.exec(s);
  const time = at?.[1] ?? "";
  const head = at ? s.slice(0, at.index).trim() : s;
  if (!time) throw new CronError(`Could not read "${text}". Use cron (e.g. "0 9 * * 1-5") or a phrase like "weekdays at 9:00".`);
  if (/^(daily|every day|each day|everyday)$/.test(head)) return presetToCron({ kind: "daily", time });
  if (/^(weekdays|every weekday|on weekdays|each weekday)$/.test(head)) return presetToCron({ kind: "weekdays", time });
  match = /^(?:every |on |each )?(sun|mon|tue|wed|thu|fri|sat)[a-z]*$/.exec(head);
  if (match) return presetToCron({ kind: "weekly", day: WEEKDAYS.indexOf(match[1]!), time });
  throw new CronError(`Could not read "${text}". Use cron (e.g. "0 9 * * 1-5") or a phrase like "weekdays at 9:00".`);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A human description of a cron expression: "Weekdays at 09:00", "Every 15 minutes", or the expression. */
export function describeCron(expression: string): string {
  let c: Cron;
  try {
    c = parseCron(expression);
  } catch {
    return expression;
  }
  const fields = (MACROS[c.source.toLowerCase()] ?? c.source).split(" ");
  const [m, h, dom, mon, dow] = fields as [string, string, string, string, string];
  const allMonths = mon === "*";
  if (dom === "*" && allMonths && dow === "*") {
    if (m === "*" && h === "*") return "Every minute";
    let step = /^\*\/(\d+)$/.exec(m);
    if (step && h === "*") return step[1] === "1" ? "Every minute" : `Every ${step[1]} minutes`;
    if (/^\d+$/.test(m) && h === "*") return Number(m) === 0 ? "Every hour" : `Every hour at :${pad(Number(m))}`;
    step = /^\*\/(\d+)$/.exec(h);
    if (/^\d+$/.test(m) && step) return `${step[1] === "1" ? "Every hour" : `Every ${step[1]} hours`}${Number(m) ? ` at :${pad(Number(m))}` : ""}`;
  }
  if (c.minutes.length === 1 && c.hours.length === 1 && dom === "*" && allMonths) {
    const time = `${pad(c.hours[0]!)}:${pad(c.minutes[0]!)}`;
    if (dow === "*") return `Daily at ${time}`;
    const days = [...c.weekdays].sort((a, b) => a - b);
    if (days.join() === "1,2,3,4,5") return `Weekdays at ${time}`;
    if (days.join() === "0,6") return `Weekends at ${time}`;
    if (days.length === 1) return `${DAY_NAMES[days[0]!]}s at ${time}`;
    return `${days.map((d) => DAY_NAMES[d]!.slice(0, 3)).join(", ")} at ${time}`;
  }
  if (c.minutes.length === 1 && c.hours.length === 1 && allMonths && dow === "*" && c.days.size === 1) {
    const day = [...c.days][0]!;
    return `Monthly on day ${day} at ${pad(c.hours[0]!)}:${pad(c.minutes[0]!)}`;
  }
  return `Cron ${c.source}`;
}
