import { getPath, setPath } from "../expression";
import { applyFormat, FORMAT_OPERATIONS } from "../format";
import type { NodeDefinition } from "../types";

interface FieldRow {
  name?: string;
  value?: unknown;
  type?: string;
  format?: string;
  formatArg?: string;
}

/** Recursively trims every string in a payload. */
function trimDeep(value: unknown): unknown {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(trimDeep);
  if (
    value &&
    typeof value === "object" &&
    (value as object).constructor === Object
  ) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      out[key] = trimDeep(child);
    }
    return out;
  }
  return value;
}

function isEmptyValue(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

/** Removes empty leaves, and any object left empty as a result. */
function pruneEmpty(value: Record<string, unknown>): void {
  for (const [key, child] of Object.entries(value)) {
    if (child && typeof child === "object" && !Array.isArray(child)) {
      pruneEmpty(child as Record<string, unknown>);
      if (Object.keys(child as object).length === 0) delete value[key];
      continue;
    }
    if (isEmptyValue(child)) delete value[key];
  }
}

function coerce(value: unknown, type: string): unknown {
  switch (type) {
    case "number": {
      const n = Number(value);
      return Number.isNaN(n) ? null : n;
    }
    case "boolean":
      if (typeof value === "boolean") return value;
      return ["true", "1", "yes", "on"].includes(String(value).toLowerCase());
    case "json":
      if (typeof value !== "string") return value;
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    case "array":
      if (Array.isArray(value)) return value;
      return String(value ?? "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
    case "date": {
      const d = new Date(String(value));
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    case "string":
    default:
      return value === null || value === undefined ? "" : String(value);
  }
}

export const transform: NodeDefinition = {
  type: "transform",
  displayName: "Edit Fields",
  group: "transform",
  version: 1,
  description:
    "Reshape data before it reaches the next step: rename fields, set fixed values, build new values from expressions, drop what you do not need.",
  icon: "Wand2",
  color: "#f59e0b",
  inputs: 1,
  outputs: [{ name: "main", label: "Output" }],
  properties: [
    {
      name: "mode",
      label: "Mode",
      type: "select",
      default: "keepAll",
      options: [
        {
          label: "Keep incoming data and add/overwrite fields",
          value: "keepAll",
        },
        {
          label: "Output only the fields I define",
          value: "onlyDefined",
        },
      ],
    },
    {
      name: "fields",
      label: "Fields",
      type: "collection",
      default: [{ name: "", value: "", type: "string" }],
      description:
        "Field name supports dot notation (customer.email). Value supports expressions such as {{ $json.first_name }} {{ $json.last_name }}.",
      fields: [
        {
          name: "name",
          label: "Field name",
          type: "string",
          placeholder: "customer.email",
        },
        {
          name: "value",
          label: "Value",
          type: "string",
          placeholder: "{{ $json.email }}",
        },
        {
          name: "format",
          label: "Clean up",
          type: "select",
          default: "none",
          options: FORMAT_OPERATIONS.map(({ value, label }) => ({
            value,
            label,
          })),
        },
        {
          name: "formatArg",
          label: "Setting",
          type: "string",
          placeholder: "e.g. 120, or ₹,2",
        },
        {
          name: "type",
          label: "Store as",
          type: "select",
          default: "string",
          options: [
            { label: "Text", value: "string" },
            { label: "Number", value: "number" },
            { label: "True/False", value: "boolean" },
            { label: "JSON", value: "json" },
            { label: "Array (comma separated)", value: "array" },
            { label: "Date (ISO)", value: "date" },
            { label: "Keep as is", value: "raw" },
          ],
        },
      ],
    },
    {
      name: "trimAllStrings",
      label: "Trim whitespace from every incoming text field",
      type: "boolean",
      default: false,
      description:
        "A quick tidy-up for messy form data. Applies to the data coming in, before your own rules run.",
    },
    {
      name: "dropEmpty",
      label: "Remove fields that end up empty",
      type: "boolean",
      default: false,
      description: "Keeps the payload passed to the next step clean.",
    },
    {
      name: "renames",
      label: "Rename fields",
      type: "collection",
      default: [],
      fields: [
        {
          name: "from",
          label: "From",
          type: "string",
          placeholder: "first_name",
        },
        { name: "to", label: "To", type: "string", placeholder: "firstName" },
      ],
    },
    {
      name: "remove",
      label: "Remove fields",
      type: "string",
      placeholder: "password, internal_id",
      description:
        "Comma separated list of fields (dot notation supported) to strip from the output.",
    },
  ],

  async execute(ctx) {
    const params = ctx.params as Record<string, any>;
    const mode = String(params.mode ?? "keepAll");

    const incoming = params.trimAllStrings
      ? (trimDeep(structuredClone(ctx.input ?? {})) as Record<string, unknown>)
      : structuredClone(ctx.input ?? {});

    const output: Record<string, unknown> = mode === "keepAll" ? incoming : {};

    for (const row of (params.renames ?? []) as Array<{
      from?: string;
      to?: string;
    }>) {
      if (!row?.from || !row?.to) continue;
      const value = getPath(ctx.input, row.from);
      setPath(output, row.to, value);
      if (mode === "keepAll" && row.from.indexOf(".") === -1)
        delete output[row.from];
    }

    for (const row of (params.fields ?? []) as FieldRow[]) {
      if (!row?.name) continue;

      // Clean first, then cast — trimming before parsing a number matters.
      const cleaned =
        row.format && row.format !== "none"
          ? applyFormat(row.value, row.format, row.formatArg ?? "")
          : row.value;

      const type = String(row.type ?? "string");
      const value = type === "raw" ? cleaned : coerce(cleaned, type);
      setPath(output, row.name, value);
    }

    const remove = String(params.remove ?? "")
      .split(",")
      .map((f) => f.trim())
      .filter(Boolean);
    for (const path of remove) {
      const parts = path.split(".");
      const last = parts.pop() as string;
      const parent = parts.length
        ? (getPath(output, parts.join(".")) as Record<string, unknown>)
        : output;
      if (parent && typeof parent === "object") delete parent[last];
    }

    if (params.dropEmpty) pruneEmpty(output);

    return { kind: "output", data: output };
  },
};

export default transform;
