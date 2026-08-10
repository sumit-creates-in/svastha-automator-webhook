/**
 * Formatting, date/time and condition tests.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyFormat,
  applyFormatChain,
  normalisePhone,
  stripHtml,
} from "./format";
import {
  addToDate,
  diffDates,
  endOfDay,
  formatDateTime,
  parseDate,
  relativeToNow,
  startOfDay,
} from "../lib/datetime";
import { evaluateCondition, evaluateConditions } from "./nodes/conditions";
import dateTime from "./nodes/dateTime";
import transform from "./nodes/transform";
import { resolveValue } from "./expression";
import type { ExpressionScope, NodeExecutionContext } from "./types";

const AT_1420_IST = "2026-08-07T08:50:00.000Z"; // 14:20 in Asia/Kolkata

function ctxFor(
  params: Record<string, unknown>,
  input: Record<string, unknown> = {},
) {
  const scope: ExpressionScope = {
    $json: input,
    $trigger: input,
    $node: {},
    $vars: {},
    $runId: "r",
    $workflowId: "w",
    $workflowName: "w",
    $now: AT_1420_IST,
    $timestamp: Date.parse(AT_1420_IST),
    $itemIndex: 0,
    $itemCount: 1,
  };
  return {
    node: {
      id: "n",
      type: "x",
      name: "Step",
      position: { x: 0, y: 0 },
      params,
    },
    params: resolveValue(params, scope),
    rawParams: params,
    input,
    scope,
    runId: "r",
    workflowId: "w",
    getConnection: async () => ({}),
    resolve: (value: unknown) => resolveValue(value, scope),
    log: () => undefined,
    signal: new AbortController().signal,
  } as NodeExecutionContext;
}

// ------------------------------------------------------------------ trimming

test("whitespace operations tidy messy form input", () => {
  assert.equal(applyFormat("  Sumit  ", "trim"), "Sumit");
  assert.equal(
    applyFormat("  Sumit   Kumar  ", "collapseSpaces"),
    "Sumit Kumar",
  );
  assert.equal(
    applyFormat("9 8765 43210", "removeSpaces"),
    "98765 43210".replace(/\s/g, ""),
  );
  assert.equal(
    applyFormat("line one\nline two", "removeLineBreaks"),
    "line one line two",
  );
});

test("case conversions", () => {
  assert.equal(applyFormat("sumit kumar", "title"), "Sumit Kumar");
  assert.equal(applyFormat("HELLO THERE", "sentence"), "Hello there");
  assert.equal(applyFormat("hello", "capitalise"), "Hello");
  assert.equal(applyFormat("My New Post!", "slug"), "my-new-post");
});

test("HTML from rich text editors is stripped safely", () => {
  assert.equal(stripHtml("<p>Hello <b>there</b></p>"), "Hello there");
  assert.equal(stripHtml("a<br>b"), "a\nb");
  assert.equal(stripHtml("<p>Tom &amp; Jerry&nbsp;won</p>"), "Tom & Jerry won");
  assert.equal(
    stripHtml("<script>alert(1)</script>Safe"),
    "Safe",
    "script bodies must not survive",
  );
});

test("truncation adds an ellipsis only when it cuts", () => {
  assert.equal(applyFormat("Hello world", "truncate", "5"), "Hello…");
  assert.equal(applyFormat("Hi", "truncate", "5"), "Hi");
  assert.equal(
    applyFormat("one two three four", "truncateWords", "2"),
    "one two…",
  );
  assert.equal(applyFormat("first\nsecond", "firstLine"), "first");
});

test("find/replace and pattern extraction", () => {
  assert.equal(
    applyFormat("Mr. Sumit", "replace", "Mr. => Mister"),
    "Mister Sumit",
  );
  assert.equal(
    applyFormat("Order 123456 shipped", "regexExtract", "\\d{6}"),
    "123456",
  );
  assert.equal(applyFormat("a@b.com", "before", "@"), "a");
  assert.equal(applyFormat("a@b.com", "after", "@"), "b.com");
  assert.equal(applyFormat("42", "padStart", "6,0"), "000042");
});

test("a broken pattern returns the value rather than failing the run", () => {
  assert.equal(applyFormat("abc", "regexExtract", "([unclosed"), "abc");
  assert.equal(applyFormat("abc", "nonsenseOperation"), "abc");
});

test("numbers and currency", () => {
  assert.equal(applyFormat("₹1,200.456", "number", "2"), 1200.46);
  assert.equal(applyFormat("7.6", "integer"), 8);
  assert.equal(applyFormat("1200.5", "currency", "₹,2"), "₹1,200.50");
  assert.equal(applyFormat("150000", "currency", "₹,0"), "₹1,50,000");
});

test("booleans, lists and fallbacks", () => {
  assert.equal(applyFormat("yes", "boolean"), true);
  assert.equal(applyFormat("0", "boolean"), false);
  assert.equal(applyFormat(true, "yesNo"), "Yes");
  assert.deepEqual(applyFormat("a, b, c", "split", ","), ["a", "b", "c"]);
  assert.equal(applyFormat(["a", "b"], "join", " | "), "a | b");
  assert.equal(applyFormat("", "default", "Not provided"), "Not provided");
  assert.equal(applyFormat("given", "default", "Not provided"), "given");
});

test("phone normalisation handles the shapes people actually send", () => {
  assert.equal(normalisePhone("98765 43210"), "919876543210");
  assert.equal(normalisePhone("+91 98765-43210"), "919876543210");
  assert.equal(normalisePhone("0098765 43210"), "919876543210");
  assert.equal(normalisePhone("919876543210"), "919876543210");
  assert.equal(normalisePhone("9876543210", "44"), "449876543210");
  assert.equal(normalisePhone(""), "");
});

test("operations can be chained", () => {
  const result = applyFormatChain("  <p>HELLO   world</p>  ", [
    { operation: "stripHtml" },
    { operation: "collapseSpaces" },
    { operation: "title" },
  ]);
  assert.equal(result, "Hello World");
});

// ---------------------------------------------------------------- date/time

test("dates are parsed from the formats webhooks send", () => {
  assert.ok(parseDate("2026-08-07T08:50:00Z"));
  assert.ok(parseDate(1786089000));
  assert.ok(parseDate(1786089000000));
  assert.equal(
    parseDate("07/08/2026")?.getUTCMonth(),
    7,
    "DD/MM/YYYY is read as August",
  );
  assert.equal(parseDate("rubbish"), null);
  assert.equal(parseDate(""), null);
});

test("tokens combine date and time into one string", () => {
  assert.equal(
    formatDateTime(AT_1420_IST, "DD MMM YYYY, h:mm a"),
    "07 Aug 2026, 2:20 pm",
  );
  assert.equal(formatDateTime(AT_1420_IST, "YYYY-MM-DD"), "2026-08-07");
  assert.equal(formatDateTime(AT_1420_IST, "dddd"), "Friday");
  assert.equal(formatDateTime(AT_1420_IST, "Do MMMM YYYY"), "7th August 2026");
  assert.equal(formatDateTime(AT_1420_IST, "HH:mm:ss"), "14:20:00");
  assert.equal(formatDateTime(AT_1420_IST, "h:mm a", "UTC"), "8:50 am");
});

test("literal text can be embedded in a pattern", () => {
  assert.equal(
    formatDateTime(AT_1420_IST, "[Received on] DD MMM [at] h:mm a"),
    "Received on 07 Aug at 2:20 pm",
  );
});

test("an unreadable date formats to empty rather than Invalid Date", () => {
  assert.equal(formatDateTime("rubbish", "DD MMM"), "");
});

test("date arithmetic respects calendar months", () => {
  const plusDays = addToDate("2026-08-07T00:00:00Z", 10, "days");
  assert.equal(plusDays?.toISOString().slice(0, 10), "2026-08-17");

  const endOfJan = addToDate("2026-01-31T00:00:00Z", 1, "months");
  assert.equal(
    endOfJan?.toISOString().slice(0, 10),
    "2026-02-28",
    "31 Jan + 1 month clamps",
  );

  const back = addToDate("2026-08-07T00:00:00Z", -1, "weeks");
  assert.equal(back?.toISOString().slice(0, 10), "2026-07-31");
});

test("differences between dates", () => {
  assert.equal(Math.round(diffDates("2026-08-01", "2026-08-08", "days")), 7);
  assert.equal(Math.round(diffDates("2026-08-08", "2026-08-01", "days")), -7);
  assert.equal(
    Math.round(
      diffDates("2026-08-07T00:00:00Z", "2026-08-07T06:00:00Z", "hours"),
    ),
    6,
  );
});

test("start and end of day respect the timezone", () => {
  const start = startOfDay(AT_1420_IST, "Asia/Kolkata");
  // Midnight IST is 18:30 UTC the previous day.
  assert.equal(start?.toISOString(), "2026-08-06T18:30:00.000Z");
  assert.equal(
    formatDateTime(start, "DD MMM h:mm a", "Asia/Kolkata"),
    "07 Aug 12:00 am",
  );

  const end = endOfDay(AT_1420_IST, "Asia/Kolkata");
  assert.equal(
    formatDateTime(end, "DD MMM HH:mm", "Asia/Kolkata"),
    "07 Aug 23:59",
  );
});

test("relative time reads naturally", () => {
  const now = new Date("2026-08-07T12:00:00Z");
  assert.equal(relativeToNow("2026-08-04T12:00:00Z", now), "3 days ago");
  assert.equal(relativeToNow("2026-08-07T14:00:00Z", now), "in 2 hours");
  assert.equal(relativeToNow("2026-08-07T11:59:30Z", now), "30 seconds ago");
});

test("the Date & Time step formats and shifts dates", async () => {
  const formatted = await dateTime.execute!(
    ctxFor({
      operation: "format",
      value: AT_1420_IST,
      pattern: "DD MMM YYYY, h:mm a",
      timezone: "Asia/Kolkata",
      outputField: "when",
    }),
  );
  assert.equal(
    formatted.kind === "output" ? formatted.data.when : null,
    "07 Aug 2026, 2:20 pm",
  );

  const added = await dateTime.execute!(
    ctxFor({
      operation: "add",
      value: AT_1420_IST,
      amount: 3,
      unit: "days",
      pattern: "YYYY-MM-DD",
      timezone: "UTC",
      outputField: "due",
    }),
  );
  assert.equal(added.kind === "output" ? added.data.due : null, "2026-08-10");
  assert.ok(
    added.kind === "output" && added.data.dueIso,
    "an ISO form is provided too",
  );
});

test("the Date & Time step explains an unreadable date", async () => {
  await assert.rejects(
    () =>
      dateTime.execute!(
        ctxFor({ operation: "format", value: "not a date", outputField: "x" }),
      ),
    /is not a date we can read/,
  );
});

// -------------------------------------------------------- Edit Fields wiring

test("Edit Fields cleans values before storing them", async () => {
  const result = await transform.execute!(
    ctxFor(
      {
        mode: "onlyDefined",
        fields: [
          {
            name: "name",
            value: "{{ $json.name }}",
            format: "title",
            type: "string",
          },
          {
            name: "bio",
            value: "{{ $json.bio }}",
            format: "stripHtml",
            type: "string",
          },
          {
            name: "mobile",
            value: "{{ $json.mobile }}",
            format: "phone",
            formatArg: "91",
            type: "string",
          },
          {
            name: "total",
            value: "{{ $json.total }}",
            format: "number",
            formatArg: "2",
            type: "number",
          },
        ],
        renames: [],
      },
      {
        name: "  sumit   kumar ",
        bio: "<p>Hello <b>world</b></p>",
        mobile: "+91 98765-43210",
        total: "₹1,200.456",
      },
    ),
  );

  assert.deepEqual(result.kind === "output" ? result.data : null, {
    name: "Sumit   Kumar",
    bio: "Hello world",
    mobile: "919876543210",
    total: 1200.46,
  });
});

test("Edit Fields can trim everything coming in and drop empties", async () => {
  const result = await transform.execute!(
    ctxFor(
      {
        mode: "keepAll",
        fields: [],
        renames: [],
        trimAllStrings: true,
        dropEmpty: true,
      },
      { a: "  spaced  ", b: "   ", c: "keep", d: { nested: "  x  " } },
    ),
  );

  const data = result.kind === "output" ? (result.data as any) : null;
  assert.equal(data.a, "spaced");
  assert.equal("b" in data, false, "blank fields are removed");
  assert.equal(data.d.nested, "x");
});

// --------------------------------------------------------------- conditions

test("the new text operators behave", () => {
  assert.equal(
    evaluateCondition({ left: "a,b", operator: "containsAny", right: "x, b" }),
    true,
  );
  assert.equal(
    evaluateCondition({ left: "a b", operator: "containsAll", right: "a, b" }),
    true,
  );
  assert.equal(
    evaluateCondition({
      left: "gold",
      operator: "notIn",
      right: "silver, bronze",
    }),
    true,
  );
  assert.equal(
    evaluateCondition({ left: "abcdef", operator: "longerThan", right: 3 }),
    true,
  );
  assert.equal(
    evaluateCondition({ left: "ab", operator: "shorterThan", right: 3 }),
    true,
  );
});

test("case sensitivity is off by default and can be turned on", () => {
  const row = { left: "PAID", operator: "equals", right: "paid" };
  assert.equal(evaluateCondition(row), true);
  assert.equal(evaluateCondition(row, true), false);
});

test("number operators cope with formatted values", () => {
  assert.equal(
    evaluateCondition({ left: "₹1,200", operator: "gt", right: "1000" }),
    true,
  );
  assert.equal(
    evaluateCondition({ left: "50", operator: "between", right: "10,100" }),
    true,
  );
  assert.equal(
    evaluateCondition({ left: "500", operator: "between", right: "10,100" }),
    false,
  );
  assert.equal(
    evaluateCondition({ left: "10", operator: "divisibleBy", right: "5" }),
    true,
  );
  assert.equal(evaluateCondition({ left: "abc", operator: "isNumber" }), false);
  assert.equal(evaluateCondition({ left: "42", operator: "isNumber" }), true);
});

test("format checks catch bad addresses and links", () => {
  assert.equal(
    evaluateCondition({ left: "a@b.com", operator: "isEmail" }),
    true,
  );
  assert.equal(
    evaluateCondition({ left: "not-an-email", operator: "isEmail" }),
    false,
  );
  assert.equal(
    evaluateCondition({ left: "https://example.com", operator: "isUrl" }),
    true,
  );
  assert.equal(
    evaluateCondition({ left: "javascript:alert(1)", operator: "isUrl" }),
    false,
  );
  assert.equal(
    evaluateCondition({ left: "+91 98765 43210", operator: "isPhone" }),
    true,
  );
});

test("relative date operators", () => {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString();
  const nextWeek = new Date(Date.now() + 7 * 86_400_000).toISOString();

  assert.equal(
    evaluateCondition({
      left: yesterday,
      operator: "withinLastDays",
      right: 7,
    }),
    true,
  );
  assert.equal(
    evaluateCondition({
      left: yesterday,
      operator: "withinLastDays",
      right: 0,
    }),
    false,
  );
  assert.equal(
    evaluateCondition({
      left: nextWeek,
      operator: "withinNextDays",
      right: 10,
    }),
    true,
  );
  assert.equal(
    evaluateCondition({ left: yesterday, operator: "inPast" }),
    true,
  );
  assert.equal(
    evaluateCondition({ left: nextWeek, operator: "inFuture" }),
    true,
  );
});

test("list operators", () => {
  assert.equal(
    evaluateCondition({ left: [1, 2], operator: "listNotEmpty" }),
    true,
  );
  assert.equal(
    evaluateCondition({ left: [], operator: "listNotEmpty" }),
    false,
  );
  assert.equal(
    evaluateCondition({ left: [1, 2, 3], operator: "listCount", right: 3 }),
    true,
  );
  assert.equal(
    evaluateCondition({
      left: ["a", "B"],
      operator: "listIncludes",
      right: "b",
    }),
    true,
  );
});

test("the NONE combinator inverts the whole set", () => {
  const rows = [
    { left: "a", operator: "equals", right: "a" },
    { left: "b", operator: "equals", right: "x" },
  ];
  assert.equal(evaluateConditions(rows, "all").passed, false);
  assert.equal(evaluateConditions(rows, "any").passed, true);
  assert.equal(evaluateConditions(rows, "none").passed, false);
  assert.equal(
    evaluateConditions([{ left: "b", operator: "equals", right: "x" }], "none")
      .passed,
    true,
  );
});

test("each condition explains itself for the run log", () => {
  const { results } = evaluateConditions(
    [{ left: "paid", operator: "equals", right: "pending" }],
    "all",
  );
  assert.match(results[0].explain, /^FAIL/);
  assert.match(results[0].explain, /is exactly/);
});

test("an unconfigured gate lets data through rather than blocking silently", () => {
  assert.equal(evaluateConditions([], "all").passed, true);
});
