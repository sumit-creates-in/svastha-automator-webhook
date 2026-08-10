import type { NodeDefinition } from "../types";
import {
  COMBINATOR_OPTIONS,
  CONDITION_OPERATORS,
  evaluateConditions,
  type ConditionRow,
} from "./conditions";

export const filter: NodeDefinition = {
  type: "filter",
  displayName: "Filter",
  group: "logic",
  version: 1,
  description:
    "Stops the workflow unless the conditions match. Use it as a gate — e.g. only continue for orders over 5000.",
  icon: "Filter",
  color: "#14b8a6",
  inputs: 1,
  outputs: [{ name: "main", label: "Passed" }],
  properties: [
    {
      name: "combinator",
      label: "Carry on when",
      type: "select",
      default: "all",
      options: COMBINATOR_OPTIONS,
    },
    {
      name: "conditions",
      label: "Continue only when",
      type: "collection",
      default: [{ left: "", operator: "isNotEmpty", right: "" }],
      description:
        "Pick the value from Available Fields on the left. Some operators (is empty, is a valid email…) need no comparison value.",
      fields: [
        {
          name: "left",
          label: "Value",
          type: "string",
          placeholder: "{{ $json.email }}",
        },
        {
          name: "operator",
          label: "Operator",
          type: "select",
          default: "equals",
          options: CONDITION_OPERATORS,
        },
        { name: "right", label: "Compare with", type: "string" },
      ],
    },
    {
      name: "caseSensitive",
      label: "Match upper and lower case exactly",
      type: "boolean",
      default: false,
    },
  ],

  async execute(ctx) {
    const params = ctx.params as Record<string, any>;
    const { passed, results } = evaluateConditions(
      (params.conditions ?? []) as ConditionRow[],
      String(params.combinator ?? "all"),
      Boolean(params.caseSensitive),
    );

    results.forEach((result) => ctx.log(result.explain));

    if (!passed) {
      const failed = results
        .filter((result) => !result.passed)
        .map((result) => result.explain);
      ctx.log("→ stopping here");
      return {
        kind: "stop",
        reason:
          failed.length > 0
            ? `Did not pass: ${failed.join("; ")}`
            : "Filter conditions not met",
        data: { passed, results },
      };
    }

    ctx.log("→ carrying on");
    return { kind: "output", data: ctx.input };
  },
};

export default filter;
