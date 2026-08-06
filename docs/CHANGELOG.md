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
