# Adding new steps

The editor builds every palette entry and every configuration form from metadata the server publishes at `GET /api/nodes`. So a new integration is **one file plus one line** — you never touch React.

---

## The three steps

### 1. Create `server/src/engine/nodes/yourNode.ts`

```ts
import type { NodeDefinition } from '../types';

export const yourNode: NodeDefinition = {
  type: 'yourNode',              // stable machine name — never change after release
  displayName: 'Your Node',      // what people see
  group: 'action',               // 'trigger' | 'action' | 'transform' | 'logic'
  version: 1,
  description: 'One clear sentence about what it does.',
  icon: 'Send',                  // see "Icons" below
  color: '#0ea5e9',
  inputs: 1,                     // 0 for triggers
  outputs: [{ name: 'main', label: 'Output' }],

  properties: [
    {
      name: 'message',
      label: 'Message',
      type: 'string',
      required: true,
      placeholder: 'Hello {{ $json.name }}',
      description: 'Shown as help text under the field.',
    },
  ],

  async execute(ctx) {
    // ctx.params  — expressions already resolved
    // ctx.input   — output of the previous step
    // ctx.scope   — $json, $trigger, $node, $vars, $now …
    // ctx.getConnection(id) — decrypted credentials
    // ctx.log(msg)          — appears in the run's step logs
    // ctx.signal            — AbortSignal for the run timeout

    ctx.log(`Sending: ${ctx.params.message}`);

    return { kind: 'output', data: { sent: true } };
  },
};

export default yourNode;
```

### 2. Register it in `server/src/engine/registry.ts`

```ts
import yourNode from './nodes/yourNode';

const definitions: NodeDefinition[] = [
  // …existing entries
  yourNode,
];
```

### 3. Restart

The palette, the config form, validation and the expression help all pick it up automatically.

---

## Property types

| `type` | Renders as | Value shape |
| --- | --- | --- |
| `string` | single-line input | `string` |
| `text` | textarea | `string` |
| `number` | number input | `number` |
| `boolean` | toggle | `boolean` |
| `select` | dropdown (needs `options`) | `string` |
| `json` | dark JSON editor | `string` — parse it yourself |
| `code` | dark code editor (`language` hint) | `string` |
| `keyValue` | repeatable name/value rows | `Array<{key, value}>` |
| `collection` | repeatable rows of `fields` | `Array<Record<string, unknown>>` |
| `connection` | credential picker (`connectionType`) | connection id `string` |
| `notice` | blue information panel | — |

### Conditional fields

```ts
{
  name: 'bodyJson',
  label: 'JSON body',
  type: 'json',
  displayOptions: {
    show: { bodyType: ['json'] },      // only when bodyType === 'json'
    hide: { method: ['GET', 'HEAD'] }, // …and never for GET/HEAD
  },
}
```

### Raw (unresolved) values

Expressions are resolved before `execute` runs. For a field that should stay literal — like the Code node's JavaScript — set `resolveExpressions: false` and read it from `ctx.rawParams`.

---

## Return values

```ts
// Normal
return { kind: 'output', data: { anything: 'you like' } };

// Choose which output handles continue (If / Else style)
return { kind: 'output', data: {...}, outputs: ['true'] };

// Stop this branch without failing the run (Filter style)
return { kind: 'stop', reason: 'Did not match', data: {...} };

// Pause and resume later (Wait style) — state is persisted
return { kind: 'wait', resumeAt: new Date(Date.now() + 3600_000), data: {...} };
```

Throwing an error fails the step. The node's **onError** setting decides whether the run stops or continues with `{ error, __failed: true }`.

---

## Icons

Icons come from [lucide.dev](https://lucide.dev). Because the client bundles only what it needs, add your icon to the map in `client/src/components/Icon.tsx`:

```ts
import { Send, /* your icon */ } from 'lucide-react';

const ICONS: Record<string, ComponentType<LucideProps>> = {
  Send,
  // …
};
```

An unmapped name falls back to a plain circle — nothing breaks, it just looks generic.

---

## Adding a credential type

Add a definition to `server/src/engine/connections.ts`:

```ts
{
  type: 'slackApi',
  displayName: 'Slack',
  description: 'Bot token from your Slack app.',
  icon: 'Slack',
  previewFields: ['workspace'],          // safe to show in lists — never secrets
  properties: [
    { name: 'workspace', label: 'Workspace', type: 'string' },
    { name: 'botToken', label: 'Bot token', type: 'string', required: true },
  ],
}
```

Fields whose names contain `password`, `secret`, `token` or `value` are masked when the edit form is loaded, and the stored value is kept if the user doesn't retype it. Everything is encrypted with AES-256-GCM before it reaches MongoDB.

Reference it from a node with:

```ts
{ name: 'connection', label: 'Slack account', type: 'connection', connectionType: 'slackApi', required: true }
```

and read it at runtime with `await ctx.getConnection(String(ctx.params.connection))`.

---

## Worked example — Slack "send message"

`server/src/engine/nodes/slackMessage.ts`:

```ts
import axios from 'axios';
import type { NodeDefinition } from '../types';

export const slackMessage: NodeDefinition = {
  type: 'slackMessage',
  displayName: 'Slack — Send Message',
  group: 'action',
  version: 1,
  description: 'Posts a message to a Slack channel.',
  icon: 'Slack',
  color: '#4a154b',
  inputs: 1,
  outputs: [{ name: 'main', label: 'Output' }],

  properties: [
    {
      name: 'connection',
      label: 'Slack account',
      type: 'connection',
      connectionType: 'slackApi',
      required: true,
    },
    {
      name: 'channel',
      label: 'Channel',
      type: 'string',
      required: true,
      placeholder: '#alerts',
    },
    {
      name: 'text',
      label: 'Message',
      type: 'text',
      rows: 4,
      required: true,
      placeholder: 'New order from {{ $json.customer.name }}',
    },
  ],

  async execute(ctx) {
    const credential = await ctx.getConnection(String(ctx.params.connection));

    const { data } = await axios.post(
      'https://slack.com/api/chat.postMessage',
      { channel: ctx.params.channel, text: ctx.params.text },
      {
        headers: { Authorization: `Bearer ${credential.botToken}` },
        signal: ctx.signal,
      },
    );

    if (!data.ok) throw new Error(`Slack rejected the message: ${data.error}`);

    ctx.log(`Posted to ${ctx.params.channel}`);
    return { kind: 'output', data: { ok: true, ts: data.ts, channel: data.channel } };
  },
};

export default slackMessage;
```

Register it, add `Slack` to the icon map, restart. Done.

---

## Adding a trigger

Triggers set `inputs: 0`, `group: 'trigger'` and a `triggerKind`, and usually have no `execute` — something outside the graph starts the run:

- `triggerKind: 'webhook'` — handled by `routes/webhook.routes.ts`
- `triggerKind: 'schedule'` — handled by `engine/scheduler.ts`
- `triggerKind: 'manual'` — started from the editor

A polling trigger (checking an inbox or an API every few minutes, say) is best built as a Schedule trigger followed by an HTTP Request and a Filter.

---

## Before you ship a node

- [ ] `type` is unique and final
- [ ] `description` reads like a sentence a non-developer understands
- [ ] Required properties are marked `required: true` — the editor blocks activation without them
- [ ] Errors thrown are specific: *what* failed and *what to change*
- [ ] Secrets come from a connection, never a plain property
- [ ] Long operations respect `ctx.signal`
- [ ] Returned data is plain JSON (no class instances, no circular references)
- [ ] Added a case to `server/src/engine/engine.test.ts`
- [ ] `npm test --prefix server` and `npm run typecheck` both pass
