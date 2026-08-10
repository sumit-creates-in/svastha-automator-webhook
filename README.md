# SVASTHA Automator

A self-hosted, visual automation platform — the parts of Uncanny Automator you actually use, without WordPress or the hosting bill that came with it.

Built with **MongoDB, Express, React and Node.js — all in TypeScript**. It deploys to Railway as a single service.

---

## What it does

**Triggers** — how a workflow starts

| Trigger | Use it for |
| --- | --- |
| **Webhook** | Receive data from anywhere: forms, WordPress, Stripe, another app. Optional token or HMAC-SHA256 verification. Can reply immediately or wait and return the workflow's output. |
| **Schedule** | Run every X minutes, hourly, daily, weekly, monthly, or on a custom cron expression, in your timezone. |
| **Manual** | Run on demand from the editor with sample data — how you build and test. |

**Actions and logic** — what happens next

| Step | Use it for |
| --- | --- |
| **HTTP Request / Send Webhook** | Call any URL. JSON, form or raw bodies, custom headers and query params, saved auth credentials, retries. |
| **Send Email** | The **Gmail API** over HTTPS (recommended — no password stored, and unaffected by hosts that block SMTP ports), or any SMTP server. HTML and/or plain text, CC/BCC, reply-to, attachments by URL. See [EMAIL-SETUP.md](docs/EMAIL-SETUP.md). |
| **Google Sheets** | Add, read, update or clear rows. Matches your data to column titles, so nobody touches a cell reference. |
| **Edit Fields** | Rename, add, remove, clean and re-type fields before passing data on. 35+ formatting operations — trim, strip HTML, truncate, currency, phone, slug — with no code. |
| **Calculate** | Add, subtract, multiply, divide, percentages, running chains, and totals from a list. |
| **Date & Time** | Format a date and time into one string, add or subtract time, compare two dates, start/end of day. Timezone-aware. |
| **Code (JavaScript)** | A sandboxed JS step for anything the other nodes can't express. |
| **If / Else** | Two output paths — true and false — with 40 comparison operators covering text, numbers, dates, formats and lists. |
| **Filter** | A gate: stop this branch unless the conditions match. Every check is logged with a PASS/FAIL line. |
| **Loop Over Items** | Run a branch once per element of a list — order line items, spreadsheet rows — then continue on `Finished`. |
| **Merge Branches** | Wait for two parallel branches and join them back into one. |
| **Wait** | Pause for a duration or until a specific time. Long waits are persisted, so a redeploy doesn't lose the run. |
| **Respond to Webhook** | Control exactly what the caller receives. |

**Building without guesswork**

- **Available Fields panel.** After any run, every field in the payload is listed as a searchable tree with sample values and type badges. Click one and the correct expression drops into whatever input you were typing in. No more hand-writing `{{ $json.body.first_name }}`.
- **Pin data.** Paste a sample output onto any step and build everything downstream without re-triggering.
- **Run from here.** Re-run starting at step five, using step four's recorded output.
- **Duplicate step.** Copy a configured step, connections and all.
- **Templates.** Five starter workflows covering the usual Uncanny Automator recipes.

**Everywhere else**

- Drag-and-drop canvas built on React Flow, with a searchable step palette
- `{{ }}` expressions with a helper library — `{{ $fn.title($json.body.name) }}`
- Full run history: every step's input, output, logs, duration and errors
- Per-step retry policy and "continue on error"
- **Failure alerts** — email on failure, or hand off to a dedicated error workflow
- Encrypted credential store (AES-256-GCM) shared across workflows
- Import/export workflows as JSON
- Email + password sign-in, with owner / admin / member roles
- No Redis needed — the job queue lives in MongoDB

---

## Quick start (local)

Prerequisites: **Node 20+** and a MongoDB you can reach (local install, Docker, or a free Atlas cluster).

```bash
cd svastha-automator

# 1. install
npm run install:all

# 2. configure
cp .env.example server/.env
#    edit server/.env — at minimum set MONGODB_URI

# 3. run (API on :8080, UI on :5173)
npm run dev
```

Open <http://localhost:5173>. The first screen asks you to create the owner account.

Optional: `npm run seed --prefix server` adds a demo "webhook → clean data → email" workflow so you can see the shape of things.

### Other commands

```bash
npm run build          # compile server + build the React app
npm start              # run the production build
npm run typecheck      # type-check both packages
npm test --prefix server   # 58 engine, graph, field and HTTP tests — no database required
```

---

## Deploying to Railway

Full walkthrough in **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**. The short version:

1. Push this folder to a GitHub repository.
2. In Railway: **New Project → Deploy from GitHub repo**. The `Dockerfile` is detected automatically.
3. Add a **MongoDB** database to the project (or use MongoDB Atlas).
4. Set the environment variables — `MONGODB_URI`, `JWT_SECRET`, `ENCRYPTION_KEY`, `APP_URL`.
5. Generate a public domain and open it.

One Railway service runs the API, the worker, the scheduler and the web UI together. For a personal setup that comfortably fits the Hobby plan.

> **Keep `ENCRYPTION_KEY` safe.** Changing it makes every saved SMTP password and API key unreadable.

---

## How a workflow runs

```
Trigger fires  ─►  Run + Job created in MongoDB
                     │
                     ▼
              Worker claims the job atomically
                     │
                     ▼
        Walk the graph from the trigger node
          ├─ resolve {{ }} expressions per step
          ├─ execute the step (with retries if configured)
          ├─ record input, output, logs, duration
          └─ follow the edges from the outputs it returned
                     │
     ┌───────────────┴───────────────┐
     ▼                               ▼
  Wait node?                    Finished
  persist state,                mark success/error,
  re-queue for later            update stats
```

Because the engine's state is stored in the run document, a workflow that's waiting three days for a follow-up email survives restarts, redeploys and crashes.

---

## Writing expressions

Anywhere you see a text field, wrap a value in `{{ }}`:

| Expression | Result |
| --- | --- |
| `{{ $json.email }}` | A field from the previous step — keeps its type |
| `Hi {{ $json.name }}!` | Interpolated into a sentence |
| `{{ $trigger.body.order_id }}` | Straight from the original trigger payload |
| `{{ $node["Clean up fields"].json.total }}` | Output of any earlier step, by name |
| `{{ $vars.supportEmail }}` | A workflow variable |
| `{{ $now }}` / `{{ $timestamp }}` | Current time |
| `{{ $json.total > 5000 ? "high" : "normal" }}` | Inline logic |
| `{{ $fn.title($json.name) }}` | Helper functions |

Helpers include `upper lower trim title slug number round json parseJson first last length join split replace defaultTo dateFormat addDays encodeUrl base64 uuid now today`.

**Formatting**

| Expression | Result |
| --- | --- |
| `{{ $fn.phone($json.mobile) }}` | `919876543210` — adds the country code, strips spaces, `+`, dashes and leading zeros |
| `{{ $fn.time($json.created_at) }}` | `2:50 pm` |
| `{{ $fn.date($json.created_at) }}` | `07 Aug 2026` |
| `{{ $fn.format($json.at, 'DD MMM YYYY, h:mm a') }}` | `07 Aug 2026, 2:20 pm` |
| `{{ $fn.dateAdd($json.at, 3, 'days') }}` | Shift a date |
| `{{ $fn.ago($json.at) }}` | `3 days ago` |
| `{{ $fn.stripHtml($json.message) }}` | Plain text from a rich-text field |
| `{{ $fn.text($json.value) }}` | Stops Google Sheets reinterpreting the value |

**Arithmetic** — `$fn.add $fn.sub $fn.mul $fn.div $fn.percentOf $fn.addPercent $fn.sum $fn.avg $fn.min $fn.max $fn.money`. For anything more than one operation, use the **Calculate** step.

A missing field resolves to empty rather than crashing the run.

---

## Reliability

Runs execute **exactly once**, which matters on platforms that restart containers routinely:

- Traversal state is written after every step, so an interrupted run resumes at the point it stopped rather than replaying.
- A run is claimed atomically and refuses to execute if it has already finished.
- A failed workflow is a finished job — it is never retried as a whole. Retries belong to individual steps (`retryOnFail`).
- Shutdown hands in-flight jobs straight back to the queue.
- The Webhook trigger can ignore repeat deliveries from senders that retry.
- **Every step has a hard time limit** (90s default, adjustable per step), so one unresponsive integration can never leave a run stuck at "Running".
- Runs orphaned by a crash are closed off automatically with an explanation.

---

## Security notes

- Passwords are hashed with **argon2id**; sessions use JWTs (bearer token + httpOnly cookie).
- Credentials are encrypted with **AES-256-GCM** and never returned to the browser in full.
- Webhook URLs contain a 22-character random id; you can add a header token or HMAC-SHA256 signature on top.
- Login is rate-limited (20 attempts / 15 min); webhooks are rate-limited (300 / min).
- The **Code** node and `{{ }}` expressions run in a locked-down `node:vm` context with a hard timeout, and no access to `require`, `process`, the filesystem or the network. This is a guard-rail against mistakes, not a defence against a hostile user — only give workflow-editing access to people you trust.

---

## Project layout

```
svastha-automator/
├─ server/                     Express API + execution engine
│  └─ src/
│     ├─ engine/
│     │  ├─ nodes/             one file per step type  ← add features here
│     │  ├─ registry.ts        the node catalogue
│     │  ├─ executor.ts        graph walker
│     │  ├─ expression.ts      the {{ }} engine
│     │  ├─ sandbox.ts         Code-node isolation
│     │  ├─ queue.ts           MongoDB-backed job queue
│     │  ├─ worker.ts          polls and executes
│     │  └─ scheduler.ts       cron → runs
│     ├─ models/               Mongoose schemas
│     ├─ routes/               REST API
│     └─ middleware/
├─ client/                     React + Vite + Tailwind + React Flow
│  └─ src/
│     ├─ components/editor/    canvas, palette, config panel
│     └─ pages/
├─ docs/
├─ Dockerfile
└─ railway.json
```

---

## Adding new steps later

The frontend renders every configuration form from metadata the server sends. **Adding an integration is one new file plus one line in the registry** — no React changes.

See **[docs/ADDING-NODES.md](docs/ADDING-NODES.md)** for a copy-paste template and a worked example (a Slack "send message" node in about 60 lines).

Ideas the architecture is already ready for: Google Sheets, Slack, WhatsApp/Twilio, Telegram, Airtable, database queries, file/CSV parsing, AI steps, loops over arrays, sub-workflows, approval steps.

---

## API reference (abridged)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness + database status |
| `POST` | `/api/auth/setup` | Create the first owner (once) |
| `POST` | `/api/auth/login` | Sign in |
| `GET` | `/api/nodes` | Node + credential catalogue |
| `GET/POST` | `/api/workflows` | List / create |
| `PUT` | `/api/workflows/:id` | Save |
| `PATCH` | `/api/workflows/:id/active` | Activate or pause |
| `POST` | `/api/workflows/:id/run` | Test run |
| `GET` | `/api/workflows/:id/export` | Export JSON |
| `GET` | `/api/runs` | Run history |
| `POST` | `/api/runs/:id/retry` | Re-run with the same payload |
| `GET/POST` | `/api/connections` | Credential store |
| `ANY` | `/api/webhooks/:webhookId[/path]` | **Public** webhook endpoint |

---

## Licence

Private — for internal use.
