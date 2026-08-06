import { getPath } from '../expression';
import type { NodeDefinition } from '../types';

export const loopItems: NodeDefinition = {
  type: 'loopItems',
  displayName: 'Loop Over Items',
  group: 'logic',
  version: 1,
  description:
    'Runs the steps on its "Each item" branch once for every element in a list — order line items, spreadsheet rows, contacts. "Finished" runs once at the end.',
  icon: 'Repeat',
  color: '#7c3aed',
  inputs: 1,
  outputs: [
    { name: 'loop', label: 'Each item', description: 'Runs once per element' },
    { name: 'done', label: 'Finished', description: 'Runs once, after every element' },
  ],
  properties: [
    {
      name: 'source',
      label: 'List to loop over',
      type: 'string',
      required: true,
      default: '{{ $json.items }}',
      placeholder: '{{ $json.body.line_items }}',
      description:
        'Point this at an array. Use the Available Fields panel to find one — arrays are marked with [ ].',
    },
    {
      name: 'maxItems',
      label: 'Maximum items',
      type: 'number',
      default: 250,
      description: 'A safety cap. The run stops with an error if the list is longer than this.',
    },
    {
      name: 'wrapNonArray',
      label: 'Treat a single object as a list of one',
      type: 'boolean',
      default: true,
      description:
        'On: if the value is a single object rather than an array, run the branch once for it instead of failing.',
    },
  ],

  async execute(ctx) {
    const params = ctx.params as Record<string, any>;
    let source: unknown = params.source;

    // Accept both a resolved array and a plain dotted path like "body.items".
    if (typeof source === 'string') {
      const trimmed = source.trim();
      if (!trimmed) throw new Error('Choose a list to loop over');
      const viaPath = getPath(ctx.input, trimmed.replace(/^\$json\./, ''));
      source = viaPath !== undefined ? viaPath : safeParse(trimmed);
    }

    let items: Array<Record<string, unknown>>;
    if (Array.isArray(source)) {
      items = source.map((entry) =>
        entry && typeof entry === 'object' && !Array.isArray(entry)
          ? (entry as Record<string, unknown>)
          : { value: entry },
      );
    } else if (source && typeof source === 'object' && params.wrapNonArray !== false) {
      items = [source as Record<string, unknown>];
    } else if (source === undefined || source === null) {
      items = [];
    } else if (params.wrapNonArray !== false) {
      items = [{ value: source }];
    } else {
      throw new Error(
        'That value is not a list. Pick a field shown as an array in Available Fields, or turn on "Treat a single object as a list of one".',
      );
    }

    const max = Number(params.maxItems ?? 250);
    if (items.length > max) {
      throw new Error(
        `The list has ${items.length} items but the maximum is ${max}. Raise "Maximum items" if that is expected.`,
      );
    }

    ctx.log(`Looping over ${items.length} item${items.length === 1 ? '' : 's'}`);

    // Each item is enriched so steps inside the branch can use {{ $json.$index }}.
    const enriched = items.map((item, index) => ({
      ...item,
      $index: index,
      $position: index + 1,
      $total: items.length,
    }));

    return {
      kind: 'fanOut',
      handle: 'loop',
      items: enriched,
      doneData: { items: enriched, count: enriched.length, source: ctx.input },
    };
  },
};

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export default loopItems;
