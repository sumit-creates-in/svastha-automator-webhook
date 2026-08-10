/**
 * Value formatting and cleaning.
 *
 * Real webhook payloads are messy — stray whitespace, HTML from rich text
 * editors, phone numbers in five different shapes, prices as `"₹1,200.00"`.
 * These operations let any value be tidied into the exact shape an action needs
 * without writing code, and the result is ordinary data so every later step can
 * use it.
 */

import { formatDateTime, parseDate } from "../lib/datetime";

export interface FormatOption {
  value: string;
  label: string;
  /** What the argument box means for this operation, if anything. */
  argLabel?: string;
  argPlaceholder?: string;
}

export const FORMAT_OPERATIONS: FormatOption[] = [
  { value: "none", label: "Leave as it is" },

  { value: "trim", label: "Trim spaces from both ends" },
  { value: "collapseSpaces", label: "Trim and collapse repeated spaces" },
  { value: "removeSpaces", label: "Remove all spaces" },
  { value: "removeLineBreaks", label: "Remove line breaks" },

  { value: "upper", label: "UPPERCASE" },
  { value: "lower", label: "lowercase" },
  { value: "title", label: "Title Case" },
  { value: "sentence", label: "Sentence case" },
  { value: "capitalise", label: "Capitalise first letter" },
  { value: "slug", label: "url-friendly-slug" },

  { value: "stripHtml", label: "Strip HTML tags" },
  {
    value: "truncate",
    label: "Shorten to a maximum length",
    argLabel: "Max characters",
    argPlaceholder: "120",
  },
  {
    value: "truncateWords",
    label: "Shorten to a number of words",
    argLabel: "Word count",
    argPlaceholder: "25",
  },
  { value: "firstLine", label: "Keep only the first line" },
  {
    value: "replace",
    label: "Find and replace",
    argLabel: "find => replace",
    argPlaceholder: "Mr. => Mister",
  },
  {
    value: "regexExtract",
    label: "Extract with a pattern",
    argLabel: "Regular expression",
    argPlaceholder: "\\d{6}",
  },
  {
    value: "before",
    label: "Keep everything before",
    argLabel: "Text to stop at",
    argPlaceholder: "@",
  },
  {
    value: "after",
    label: "Keep everything after",
    argLabel: "Text to start from",
    argPlaceholder: "@",
  },
  {
    value: "padStart",
    label: "Pad the start",
    argLabel: "length,character",
    argPlaceholder: "6,0",
  },

  { value: "digitsOnly", label: "Digits only" },
  { value: "lettersOnly", label: "Letters and spaces only" },
  { value: "email", label: "Clean up an email address" },
  {
    value: "phone",
    label: "Phone number with country code",
    argLabel: "Country code",
    argPlaceholder: "91",
  },

  {
    value: "number",
    label: "Number",
    argLabel: "Decimal places",
    argPlaceholder: "2",
  },
  {
    value: "currency",
    label: "Currency amount",
    argLabel: "Symbol,decimals",
    argPlaceholder: "₹,2",
  },
  { value: "integer", label: "Whole number" },
  { value: "boolean", label: "True / false" },
  { value: "yesNo", label: "Yes / No" },

  {
    value: "date",
    label: "Date and time",
    argLabel: "Pattern",
    argPlaceholder: "DD MMM YYYY, h:mm a",
  },

  { value: "jsonStringify", label: "Convert to JSON text" },
  { value: "jsonParse", label: "Parse JSON text" },
  {
    value: "join",
    label: "Join a list into text",
    argLabel: "Separator",
    argPlaceholder: ", ",
  },
  {
    value: "split",
    label: "Split text into a list",
    argLabel: "Separator",
    argPlaceholder: ",",
  },
  {
    value: "default",
    label: "Use a fallback when empty",
    argLabel: "Fallback value",
    argPlaceholder: "Not provided",
  },
  { value: "forceText", label: "Spreadsheet text (leading ')" },
];

function toText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function toNumberLoose(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const cleaned = toText(value).replace(/[^0-9.\-eE]/g, "");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

const HTML_ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

export function stripHtml(value: unknown): string {
  return (
    toText(value)
      // Drop script/style bodies entirely rather than leaving their contents behind.
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]*>/g, "")
      .replace(
        /&[a-z#0-9]+;/gi,
        (entity) => HTML_ENTITIES[entity.toLowerCase()] ?? entity,
      )
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

export function normalisePhone(value: unknown, countryCode = "91"): string {
  const cc = String(countryCode).replace(/\D/g, "") || "91";
  let digits = toText(value).replace(/\D/g, "");
  if (!digits) return "";

  digits = digits.replace(/^00/, "");
  while (digits.startsWith("0")) digits = digits.slice(1);
  if (!digits.startsWith(cc) || digits.length <= 10) digits = `${cc}${digits}`;
  return digits;
}

/**
 * Applies one formatting operation.
 *
 * Never throws: a bad argument returns the value untouched, because losing a
 * whole run over a malformed pattern helps nobody.
 */
export function applyFormat(
  value: unknown,
  operation: string,
  arg = "",
): unknown {
  /*
   * Kept verbatim. Separators and padding characters are frequently spaces —
   * trimming the argument turned a " | " separator into "|".
   */
  const argument = String(arg ?? "");

  try {
    switch (operation) {
      case "none":
      case "":
        return value;

      case "trim":
        return toText(value).trim();
      case "collapseSpaces":
        return toText(value).replace(/\s+/g, " ").trim();
      case "removeSpaces":
        return toText(value).replace(/\s+/g, "");
      case "removeLineBreaks":
        return toText(value)
          .replace(/[\r\n]+/g, " ")
          .replace(/\s+/g, " ")
          .trim();

      /*
       * Case conversions also trim the ends. Choosing "Title Case" on a value
       * that arrives as "  sumit kumar " and getting the padding back is never
       * what anyone wants. Internal spacing is left alone — that is what
       * "collapse repeated spaces" is for.
       */
      case "upper":
        return toText(value).trim().toUpperCase();
      case "lower":
        return toText(value).trim().toLowerCase();
      case "title":
        return toText(value)
          .trim()
          .toLowerCase()
          .replace(/\b[\p{L}]/gu, (character) => character.toUpperCase());
      case "sentence": {
        const text = toText(value).trim().toLowerCase();
        return text.charAt(0).toUpperCase() + text.slice(1);
      }
      case "capitalise": {
        const text = toText(value).trim();
        return text.charAt(0).toUpperCase() + text.slice(1);
      }
      case "slug":
        return toText(value)
          .toLowerCase()
          .trim()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "");

      case "stripHtml":
        return stripHtml(value);

      case "truncate": {
        const max = Number(argument.trim()) || 100;
        const text = toText(value);
        return text.length <= max ? text : `${text.slice(0, max).trimEnd()}…`;
      }
      case "truncateWords": {
        const max = Number(argument.trim()) || 25;
        const words = toText(value).trim().split(/\s+/);
        return words.length <= max
          ? words.join(" ")
          : `${words.slice(0, max).join(" ")}…`;
      }
      case "firstLine":
        return toText(value)
          .split(/[\r\n]/)[0]
          .trim();

      case "replace": {
        const [find, replacement = ""] = argument
          .split("=>")
          .map((part) => part.trim());
        if (!find) return value;
        return toText(value).split(find).join(replacement);
      }
      case "regexExtract": {
        if (!argument.trim()) return value;
        const match = toText(value).match(new RegExp(argument.trim()));
        // Prefer the first capture group when the pattern defines one.
        return match ? (match[1] ?? match[0]) : "";
      }
      case "before": {
        const text = toText(value);
        const index = text.indexOf(argument);
        return index === -1 ? text : text.slice(0, index);
      }
      case "after": {
        const text = toText(value);
        const index = text.indexOf(argument);
        return index === -1 ? text : text.slice(index + argument.length);
      }
      case "padStart": {
        const [lengthRaw, character = "0"] = argument.split(",");
        const length = Number(lengthRaw.trim()) || 0;
        return toText(value).padStart(length, character || "0");
      }

      case "digitsOnly":
        return toText(value).replace(/\D/g, "");
      case "lettersOnly":
        return toText(value)
          .replace(/[^\p{L}\s]/gu, "")
          .replace(/\s+/g, " ")
          .trim();
      case "email":
        return toText(value).trim().toLowerCase().replace(/\s+/g, "");
      case "phone":
        return normalisePhone(value, argument || "91");

      case "number": {
        const decimals = argument === "" ? undefined : Number(argument);
        const parsed = toNumberLoose(value);
        return decimals === undefined || Number.isNaN(decimals)
          ? parsed
          : Number(parsed.toFixed(Math.max(0, Math.min(10, decimals))));
      }
      case "integer":
        return Math.round(toNumberLoose(value));
      case "currency": {
        const [symbol = "", decimalsRaw = "2"] = argument.split(",");
        const decimals = Number(decimalsRaw);
        const amount = toNumberLoose(value).toFixed(
          Number.isNaN(decimals) ? 2 : Math.max(0, Math.min(10, decimals)),
        );
        // Indian grouping is the common case here; en-IN handles lakhs correctly.
        const [whole, fraction] = amount.split(".");
        const grouped = Number(whole).toLocaleString("en-IN");
        return `${symbol}${grouped}${fraction ? `.${fraction}` : ""}`;
      }

      case "boolean": {
        if (typeof value === "boolean") return value;
        return ["true", "1", "yes", "y", "on"].includes(
          toText(value).trim().toLowerCase(),
        );
      }
      case "yesNo": {
        const truthy =
          typeof value === "boolean"
            ? value
            : ["true", "1", "yes", "y", "on"].includes(
                toText(value).trim().toLowerCase(),
              );
        return truthy ? "Yes" : "No";
      }

      case "date": {
        const date = parseDate(value);
        if (!date) return "";
        return formatDateTime(date, argument || "DD MMM YYYY, h:mm a");
      }

      case "jsonStringify":
        return JSON.stringify(value ?? null);
      case "jsonParse": {
        if (typeof value !== "string") return value;
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      }
      case "join":
        return Array.isArray(value)
          ? value.map(toText).join(argument || ", ")
          : toText(value);
      case "split":
        return toText(value)
          .split(argument || ",")
          .map((part) => part.trim())
          .filter(Boolean);

      case "default": {
        const empty =
          value === null ||
          value === undefined ||
          value === "" ||
          (Array.isArray(value) && value.length === 0);
        return empty ? argument : value;
      }

      case "forceText": {
        const text = toText(value);
        return text === "" || text.startsWith("'") ? text : `'${text}`;
      }

      default:
        return value;
    }
  } catch {
    return value;
  }
}

/** Runs several operations in order. */
export function applyFormatChain(
  value: unknown,
  operations: Array<{ operation?: string; arg?: string }>,
): unknown {
  return operations.reduce<unknown>(
    (current, step) =>
      step?.operation
        ? applyFormat(current, step.operation, step.arg ?? "")
        : current,
    value,
  );
}
