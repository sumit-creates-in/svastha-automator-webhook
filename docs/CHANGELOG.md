# What changed in v1.2

## Duplicate actions, inconsistent sheet rows, unreliable email

All three symptoms were one bug, and your logs pinned it down.

### The evidence

```
container up for 11.5 s   started 2026-08-06T08:40:03
container up for 14.6 s   started 2026-08-07T04:56:01
container up for 15.1 s   started 2026-08-07T04:57:00
container up for 13.8 s   started 2026-08-07T05:17:42
container up for 15.6 s   started 2026-08-07T05:19:20
```

The container was being killed roughly every **fifteen seconds**, five times over. The 08-06 entry shows the app getting as far as `Engine worker started` before `Stopping Container` arrived six seconds later.

### Why that produced duplicates

1. A run starts. The worker claims its job (`status: 'active'`).
2. The container is killed part-way through — say after the HTTP Request but before the email.
3. The job stays locked. Ten minutes later `reclaimStalledJobs()` returns it to `pending`.
4. A worker picks it up and calls `executeRun(runId)`.
5. **`state` was only persisted on a Wait step.** With nothing to resume from, `runGraph` re-seeded from the trigger and replayed *everything* — sending the webhook again and adding the spreadsheet row again.

Independently, `failJob()` retried the whole run up to three times on any failure, replaying every already-successful step each time.

That accounts for each symptom exactly:

| Symptom | Cause |
| --- | --- |
| Webhook called several times | Replay from the trigger on reclaim/retry |
| Sheets row sometimes added, sometimes not, sometimes twice | Killed before the step on one attempt, replayed on the next |
| Email sometimes sent, sometimes not | It was last in the chain — often the container died first |

### The fix

- **State is persisted after every step**, not just on Wait (`executor.ts`, `onStep`). An interrupted run resumes from the exact point it stopped; steps in `state.executed` never run again.
- **Runs are one-shot.** `executeRun` now claims the run with an atomic `findOneAndUpdate` and refuses anything already in a terminal state, so a double-claimed job is a no-op rather than a second execution.
- **Whole-run retries removed.** A failed workflow is a *finished* job — `worker.process` calls `completeJob`, not `failJob`. Step-level `retryOnFail` remains the right place to retry, because it retries one step rather than the whole graph.
- **Graceful shutdown hands jobs back immediately** instead of leaving them locked for the ten-minute stale sweep.
- **Incoming duplicate suppression.** The Webhook trigger gains *"Ignore repeat deliveries for (seconds)"* — many senders retry when a reply is slow, which would otherwise start the workflow twice. Optionally keyed on a field such as `body.order_id`.

Two regression tests lock this in: *a run interrupted mid-way resumes without replaying finished steps*, and *resuming from persisted state never re-seeds from the trigger*.

> **Worth investigating separately:** a container restarting every fifteen seconds is not normal. The engine now tolerates it, but it will still cost you latency and half-finished runs. Check Railway → Deployments for OOM kills, and confirm `/api/health` responds before `healthcheckTimeout`. If those logs were captured during a burst of redeploys, you can ignore this.

## Phone numbers and times as literal text

Google Sheets parses whatever it is handed: `2:50 pm` becomes a time value, and a phone number can lose its leading digits or appear in scientific notation.

New expression helpers:

| Expression | Result |
| --- | --- |
| `{{ $fn.phone($json.mobile) }}` | `919876543210` — adds 91, strips spaces, `+`, dashes and leading zeros |
| `{{ $fn.phone($json.mobile, '44') }}` | Any country code |
| `{{ $fn.phone($json.mobile, '91', '+') }}` | `+919876543210` |
| `{{ $fn.time($json.created_at) }}` | `2:50 pm` (Asia/Kolkata by default) |
| `{{ $fn.date($json.created_at) }}` | `07 Aug 2026` |
| `{{ $fn.text($json.anything) }}` | Prefixes `'` so Sheets stores it verbatim |

Running `$fn.phone` twice is harmless — an already-prefixed number is left alone.

The **Google Sheets** node now has a **Store as** setting per column (Text / Phone number / Number / Let Sheets decide), plus a **Default for every column** which is set to **Text** — so values arrive exactly as written unless you ask otherwise.

## Calculate node

Arithmetic without code, in four modes:

- **Two values and an operation** — add, subtract, multiply, divide, remainder, power, percent of, add percent, subtract percent, smaller, larger.
- **A chain of steps** — start from a value, then apply operations in order. `1000 − 100 + 18% = 1062`.
- **A formula** — `({{ $json.price }} * {{ $json.qty }}) * 1.18`, with `round`, `floor`, `ceil`, `abs`, `min`, `max`, `sqrt`. Anything that is not plain arithmetic is rejected before evaluation.
- **Totals from a list** — sum, average, count, smallest or largest across an array, optionally reading one field from each item.

Plus rounding control, a nested output field (`order.grandTotal`), and an optional `…Text` version with fixed decimals for emails and spreadsheets. Division by zero gives `0`, never `Infinity`.

Inline equivalents also exist: `$fn.add $fn.sub $fn.mul $fn.div $fn.percentOf $fn.addPercent $fn.sum $fn.avg $fn.min $fn.max $fn.money`.

Test suite: **58 → 81**.

---

# What changed in v1.1

## Bug fixes

### Only one action ran when a trigger had several attached

**Cause:** `client/src/components/editor/FlowNode.tsx:35` gave every step's input handle the explicit id `"in"`, but `targetHandle` was never persisted — not in the Mongoose edge schema, not in the client's `WorkflowEdgeData`, and not in `buildPayload()` (`WorkflowEditor.tsx:280`).

On reload, edges came back with `targetHandle: undefined` while the node advertised a handle called `"in"`. React Flow cannot pair those, so the connection stopped rendering. Redrawing it created a second edge, and the saved graph and the visible graph drifted apart.

**Fix:**

- Single-input steps now use React Flow's **default unnamed handle**, so no `targetHandle` is required to re-attach.
- `targetHandle` is persisted end to end — Mongoose schema, zod validation, client type, save payload — because join nodes genuinely need named inputs.
- Graph traversal was extracted into `server/src/engine/graph.ts`, a pure function with no database dependency, and covered by 19 tests. `a trigger wired to three actions runs all three` is now a permanent regression test, alongside diamonds, joins, loops, disabled steps and resume-after-wait.

### Runs marked Error ~30 seconds after the action succeeded

**Cause:** `httpRequest`'s default **Timeout (ms)** was `30000`. The Google Sheets API regularly takes longer than that to acknowledge a write. Axios aborted at 30s, the node threw, and the run was recorded as failed — even though Google had already accepted the row.

**Fix:**

- Default timeout raised to **120,000 ms**, with help text explaining when to raise it.
- New `describeRequestFailure()` classifies failures instead of reporting them all identically. A timeout now reads: *"the server did not reply within 30.0s… the request may still have been received and processed."* Separate messages cover cancellation, DNS failure, refused connections and TLS problems.
- The dedicated **Google Sheets** node avoids the situation entirely — it uses its own 60s budget and returns the written range.

> If you have existing HTTP Request steps, open each one and check **Timeout (ms)** — saved workflows keep whatever value they were created with.

---

## Available Fields

After any run, the trigger payload is captured (trimmed, not archived) and every field is listed as a searchable tree beside the step configuration.

- Nested objects and arrays are walked recursively; `body.line_items[0].sku` is discovered, not just `body`.
- Type badges (`Aa`, `12`, `T/F`, `{ }`, `[ ]`) and a sample value per field.
- Clicking a field inserts the correct expression **at the cursor** of whichever input you were last typing in.
- Awkward key names are escaped correctly — `first name` becomes `{{ $json["first name"] }}`.
- Request headers are de-noised; recursion is bounded at 8 levels and 800 fields so a pathological payload cannot hang the editor.
- With no sample yet: *"Run the webhook once to discover available fields."* — with buttons to test-run or paste a sample.

Fields from **earlier steps** appear too, correctly scoped: the step immediately upstream as `$json`, anything further back as `$node["Step name"].json`.

## New steps

- **Google Sheets** — append, read, update (with upsert) and clear, matched by column title. See [GOOGLE-SHEETS.md](GOOGLE-SHEETS.md).
- **Loop Over Items** — runs a branch once per array element, with a `Finished` output that fires after every iteration. Inside the loop, `{{ $json.$index }}` and `{{ $itemIndex }}` are available.
- **Merge Branches** — waits for two branches and joins them (combine / keep separate / append / first wins). If one branch is filtered away it still fires once everything else is done, so it cannot deadlock a run.

## New connections

- **Google (Service Account)** — paste a JSON key, share the sheet with the service account email. Nothing expires.
- **Google (Sign in)** — one-click OAuth with refresh-token storage and a self-closing popup.

## Productivity

- **Pin data** — paste a sample output onto any step; downstream steps can then be configured and browsed without running anything.
- **Run from here** — start a run at a chosen step, seeded from pinned data or that step's last recorded input.
- **Duplicate step** — copies a configured step with a unique name.
- **Templates** — five starter workflows: form→email, webhook→sheet, one-trigger-three-actions, loop over line items, daily scheduled report.
- **Failure alerts** — email addresses to notify on failure, and/or a designated error workflow. Alerting runs detached, so a broken alert can never become a second incident, and a workflow cannot be its own error handler.

## Under the hood

- Traversal state is plain JSON and survives a round-trip through MongoDB, so a run paused mid-branch resumes correctly in another process — including the branches that had not started yet.
- Runaway graphs stop at 1,000 steps with a clear message.
- Test suite: **26 → 58**.
