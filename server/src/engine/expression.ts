import vm from "node:vm";
import {
  addToDate,
  diffDates,
  formatDateTime,
  relativeToNow,
  type DateUnit,
} from "../lib/datetime";
import { applyFormat } from "./format";
import type { ExpressionScope } from "./types";

/**
 * Expression engine for {{ ... }} templates.
 *
 * Rules:
 *  - "{{ $json.email }}"            -> returns the raw value (keeps numbers/objects/booleans)
 *  - "Hello {{ $json.name }}!"      -> string interpolation
 *  - Any JS expression is allowed, evaluated in a locked-down VM context with a
 *    hard timeout. There is no access to require/process/fs.
 *  - Unresolvable paths yield '' (in interpolation) or undefined (single expression),
 *    so a missing field never crashes a workflow.
 */

const EXPRESSION_RE = /\{\{([\s\S]*?)\}\}/g;
const EVAL_TIMEOUT_MS = 250;

/** Helper functions exposed to every expression. */
const helpers = {
  now: () => new Date().toISOString(),
  today: () => new Date().toISOString().slice(0, 10),
  uuid: () =>
    "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    }),
  upper: (v: unknown) => String(v ?? "").toUpperCase(),
  lower: (v: unknown) => String(v ?? "").toLowerCase(),
  trim: (v: unknown) => String(v ?? "").trim(),
  title: (v: unknown) =>
    String(v ?? "")
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase()),
  slug: (v: unknown) =>
    String(v ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, ""),
  number: (v: unknown) => Number(v),
  round: (v: unknown, digits = 0) => {
    const factor = 10 ** digits;
    return Math.round(Number(v) * factor) / factor;
  },
  json: (v: unknown) => JSON.stringify(v),
  parseJson: (v: unknown) => {
    try {
      return JSON.parse(String(v));
    } catch {
      return null;
    }
  },
  first: (v: unknown) => (Array.isArray(v) ? v[0] : v),
  last: (v: unknown) => (Array.isArray(v) ? v[v.length - 1] : v),
  length: (v: unknown) =>
    Array.isArray(v)
      ? v.length
      : typeof v === "string"
        ? v.length
        : Object.keys(v ?? {}).length,
  join: (v: unknown, sep = ", ") =>
    Array.isArray(v) ? v.join(sep) : String(v ?? ""),
  split: (v: unknown, sep = ",") => String(v ?? "").split(sep),
  replace: (v: unknown, find: string, repl: string) =>
    String(v ?? "")
      .split(find)
      .join(repl),
  defaultTo: (v: unknown, fallback: unknown) =>
    v === undefined || v === null || v === "" ? fallback : v,
  dateFormat: (v: unknown, locale = "en-GB") => {
    const d = v ? new Date(String(v)) : new Date();
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(locale);
  },
  addDays: (v: unknown, days: number) => {
    const d = v ? new Date(String(v)) : new Date();
    d.setDate(d.getDate() + Number(days));
    return d.toISOString();
  },
  encodeUrl: (v: unknown) => encodeURIComponent(String(v ?? "")),
  base64: (v: unknown) =>
    Buffer.from(String(v ?? ""), "utf8").toString("base64"),

  /**
   * Normalises a mobile number to full international form.
   *
   *   $fn.phone("98765 43210")        -> "919876543210"
   *   $fn.phone("0 9876543210")       -> "919876543210"
   *   $fn.phone("+91-9876543210")     -> "919876543210"
   *   $fn.phone("9876543210", "44")   -> "449876543210"
   *   $fn.phone("9876543210", "91", "+") -> "+919876543210"
   *
   * Already-prefixed numbers are left alone, so running it twice is harmless.
   */
  phone: (v: unknown, countryCode: string | number = "91", prefix = "") => {
    const cc = String(countryCode).replace(/\D/g, "") || "91";
    let digits = String(v ?? "").replace(/\D/g, "");
    if (!digits) return "";

    // Strip trunk zeros and any 00 international prefix.
    digits = digits.replace(/^00/, "");
    while (digits.startsWith("0")) digits = digits.slice(1);

    // A 10-digit national number needs the country code; a longer one has it.
    if (!digits.startsWith(cc) || digits.length <= 10) {
      digits = `${cc}${digits}`;
    }
    return `${prefix}${digits}`;
  },

  /** Just the digits, no country code — useful for display. */
  digits: (v: unknown) => String(v ?? "").replace(/\D/g, ""),

  /**
   * Formats a time as a short 12-hour string: "2:50 pm".
   * Accepts an ISO date, a timestamp, or nothing (meaning now).
   */
  time: (v: unknown, timezone = "Asia/Kolkata") => {
    const date =
      v === undefined || v === null || v === ""
        ? new Date()
        : new Date(String(v));
    if (Number.isNaN(date.getTime())) return "";
    return date
      .toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZone: timezone,
      })
      .toLowerCase()
      .replace(/\s+/g, " ");
  },

  /** Short date in the given timezone: "07 Aug 2026". */
  date: (v: unknown, timezone = "Asia/Kolkata") => {
    const date =
      v === undefined || v === null || v === ""
        ? new Date()
        : new Date(String(v));
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      timeZone: timezone,
    });
  },

  /**
   * Forces a value to be stored as literal text in Google Sheets.
   *
   * Sheets parses anything that looks like a number or a time, so "2:50 pm"
   * becomes a time value and a phone number loses its leading digits. A leading
   * apostrophe is the spreadsheet convention for "leave this exactly as typed" —
   * it is not displayed in the cell.
   */
  text: (v: unknown) => {
    const value = v === null || v === undefined ? "" : String(v);
    if (value === "" || value.startsWith("'")) return value;
    return `'${value}`;
  },

  // ---- arithmetic ---------------------------------------------------------
  add: (a: unknown, b: unknown) => toNumber(a) + toNumber(b),
  sub: (a: unknown, b: unknown) => toNumber(a) - toNumber(b),
  mul: (a: unknown, b: unknown) => toNumber(a) * toNumber(b),
  div: (a: unknown, b: unknown) => {
    const divisor = toNumber(b);
    return divisor === 0 ? 0 : toNumber(a) / divisor;
  },
  mod: (a: unknown, b: unknown) => {
    const divisor = toNumber(b);
    return divisor === 0 ? 0 : toNumber(a) % divisor;
  },
  pow: (a: unknown, b: unknown) => toNumber(a) ** toNumber(b),
  /** `$fn.percentOf(1200, 18)` -> 216 */
  percentOf: (value: unknown, percent: unknown) =>
    (toNumber(value) * toNumber(percent)) / 100,
  /** `$fn.addPercent(1200, 18)` -> 1416 (handy for GST) */
  addPercent: (value: unknown, percent: unknown) =>
    toNumber(value) + (toNumber(value) * toNumber(percent)) / 100,
  sum: (list: unknown) =>
    Array.isArray(list)
      ? list.reduce<number>((t, v) => t + toNumber(v), 0)
      : toNumber(list),
  avg: (list: unknown) =>
    Array.isArray(list) && list.length > 0
      ? list.reduce<number>((t, v) => t + toNumber(v), 0) / list.length
      : 0,
  min: (list: unknown) =>
    Array.isArray(list) ? Math.min(...list.map(toNumber)) : toNumber(list),
  max: (list: unknown) =>
    Array.isArray(list) ? Math.max(...list.map(toNumber)) : toNumber(list),
  /** Fixed decimal places, returned as a string: "1416.00" */
  money: (v: unknown, digits = 2) => toNumber(v).toFixed(digits),

  // ---- dates --------------------------------------------------------------
  /** `$fn.format($json.created_at, 'DD MMM YYYY, h:mm a')` -> "07 Aug 2026, 2:50 pm" */
  format: (
    v: unknown,
    pattern = "DD MMM YYYY, h:mm a",
    timezone = "Asia/Kolkata",
  ) => formatDateTime(v, pattern, timezone),
  dateAdd: (v: unknown, amount: number, unit: DateUnit = "days") =>
    addToDate(v, Number(amount), unit)?.toISOString() ?? "",
  dateSub: (v: unknown, amount: number, unit: DateUnit = "days") =>
    addToDate(v, -Number(amount), unit)?.toISOString() ?? "",
  dateDiff: (from: unknown, to: unknown, unit: DateUnit = "days") =>
    diffDates(from, to, unit),
  ago: (v: unknown) => relativeToNow(v),

  /** Cleaning operations, also available as a dropdown on the Edit Fields step. */
  clean: (v: unknown, operation: string, arg = "") =>
    applyFormat(v, operation, arg),
  stripHtml: (v: unknown) => applyFormat(v, "stripHtml"),
  truncate: (v: unknown, length = 100) =>
    applyFormat(v, "truncate", String(length)),
  currency: (v: unknown, symbol = "₹", digits = 2) =>
    applyFormat(v, "currency", `${symbol},${digits}`),
};

/** Lenient number parsing — copes with "₹1,200.50" and " 42 ". */
export function toNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === null || value === undefined) return 0;

  const cleaned = String(value).replace(/[^0-9.\-eE]/g, "");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

export type ExpressionHelpers = typeof helpers;

function buildSandbox(scope: ExpressionScope) {
  return Object.freeze({
    ...scope,
    $fn: helpers,
    JSON,
    Math,
    Date,
    Number,
    String,
    Boolean,
    Array,
    Object,
    isNaN,
    parseInt,
    parseFloat,
    encodeURIComponent,
    decodeURIComponent,
  });
}

function evaluate(expression: string, scope: ExpressionScope): unknown {
  const code = expression.trim();
  if (!code) return undefined;

  const context = vm.createContext(buildSandbox(scope), {
    codeGeneration: { strings: false, wasm: false },
  });

  try {
    const script = new vm.Script(`(${code})`, { filename: "expression.js" });
    return script.runInContext(context, { timeout: EVAL_TIMEOUT_MS });
  } catch (error) {
    // Errors raised inside the VM belong to the sandbox realm, so `instanceof`
    // does not work here — compare the error name instead.
    const name = (error as { name?: string })?.name;
    if (name === "ReferenceError" || name === "TypeError") return undefined;
    throw new Error(
      `Expression error in "{{ ${code} }}": ${
        (error as { message?: string })?.message ?? String(error)
      }`,
    );
  }
}

export function hasExpression(value: unknown): boolean {
  return typeof value === "string" && /\{\{[\s\S]*?\}\}/.test(value);
}

/** Resolve expressions inside a single string. */
export function resolveString(input: string, scope: ExpressionScope): unknown {
  const matches = [...input.matchAll(EXPRESSION_RE)];
  if (matches.length === 0) return input;

  const whole = matches[0];
  if (matches.length === 1 && whole[0].length === input.length) {
    return evaluate(whole[1], scope);
  }

  return input.replace(EXPRESSION_RE, (_full, expr: string) => {
    const value = evaluate(expr, scope);
    if (value === undefined || value === null) return "";
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  });
}

/** Deeply resolve expressions in any value (strings, arrays, plain objects). */
export function resolveValue<T>(value: T, scope: ExpressionScope): T {
  if (typeof value === "string") return resolveString(value, scope) as T;
  if (Array.isArray(value))
    return value.map((item) => resolveValue(item, scope)) as unknown as T;
  if (
    value &&
    typeof value === "object" &&
    (value as object).constructor === Object
  ) {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = resolveValue(val, scope);
    }
    return out as T;
  }
  return value;
}

/** Safe read of a dotted path, e.g. getPath(obj, 'user.address.city'). */
export function getPath(source: unknown, path: string): unknown {
  if (!path) return source;
  return path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean)
    .reduce<unknown>((acc, key) => {
      if (acc === null || acc === undefined) return undefined;
      return (acc as Record<string, unknown>)[key];
    }, source);
}

/** Safe write of a dotted path onto a target object (creates intermediate objects). */
export function setPath(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const keys = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
  let cursor: Record<string, unknown> = target;
  keys.forEach((key, index) => {
    if (index === keys.length - 1) {
      cursor[key] = value;
      return;
    }
    if (typeof cursor[key] !== "object" || cursor[key] === null) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  });
}

export { helpers as expressionHelpers };
