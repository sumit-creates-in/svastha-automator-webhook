# Connecting Google Sheets

There are two ways to connect. For a self-hosted tool writing to your own spreadsheets, **a service account is almost always the right answer** — no consent screen, no expiring tokens, no re-authorising, and it never breaks because somebody changed their password.

| | **Service account** (recommended) | **Sign in with Google** |
| --- | --- | --- |
| Setup | Paste a JSON key once | Create an OAuth client, then click Connect |
| Maintenance | None — it never expires | Re-authorise if access is revoked |
| Who owns new files | The service account | You |
| Sharing | You must share each sheet with its email | Sees everything your account can |

---

## Option A — Service account (10 minutes, once)

### 1. Create the key

1. Go to <https://console.cloud.google.com> and create a project (or pick an existing one).
2. **APIs & Services → Library** → search **Google Sheets API** → **Enable**.
3. **IAM & Admin → Service Accounts → Create service account**.
   - Name it `svastha-automator`. Skip the optional role and user steps.
4. Open the new account → **Keys → Add key → Create new key → JSON**.
5. A `.json` file downloads. Open it in a text editor.

### 2. Add it to SVASTHA Automator

**Connections → New connection → Google (Service Account)**

- **Connection name**: `Google Sheets`
- **Service account JSON key**: paste the entire file, including the outer `{ }`
- Save

The connection card now shows the **service account email**, something like
`svastha-automator@your-project.iam.gserviceaccount.com`.

### 3. Share your spreadsheet

Open the spreadsheet → **Share** → paste that email → give it **Editor** → Send.

This step is the one people forget. Without it Google returns *"The caller does not have permission"* — the connection is fine, it simply hasn't been invited to the file.

### 4. Test

Back in Connections, click the flask icon. Green means Google issued a token.

---

## Option B — Sign in with Google

Use this when the rows must be written *as you*, or the sheet lives somewhere you cannot share.

1. **Google Cloud → APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Application type: **Web application**
   - Authorised redirect URI — exactly this, no trailing slash:

     ```
     https://your-app.up.railway.app/api/connections/oauth/google/callback
     ```

2. In SVASTHA Automator: **Connections → New → Google (Sign in)**, paste the **Client ID** and **Client secret**, save.
3. Click **Connect with Google** on the connection card, choose your account, approve.
4. Test the connection.

If Google says *"did not return a refresh token"*, the account was already connected once. Remove SVASTHA Automator at <https://myaccount.google.com/permissions> and connect again.

---

## Using the Google Sheets step

Add the step, choose your connection, then:

| Field | What to put |
| --- | --- |
| **What should happen** | Add a new row / Read rows / Update an existing row / Clear a range |
| **Spreadsheet** | Paste the whole share link — the id is extracted for you |
| **Tab name** | The tab along the bottom, e.g. `Sheet1`. Case-sensitive |
| **Header row number** | Usually `1` |
| **Columns to write** | One row per column: the **column title exactly as it appears in the sheet**, and the value |

Values come from the **Available Fields** panel on the left — click a field and it drops into the box you were typing in.

```
Column title      Value
────────────      ─────────────────────────────
Date              {{ $now }}
Name              {{ $json.body.name }}
Email             {{ $json.body.email }}
Order total       {{ $json.body.order.total }}
```

Column titles are matched case-insensitively. If a title doesn't exist in the sheet, the run **still succeeds** and the step logs a warning naming the columns it did find — check the Logs section of the run to see it.

### Updating instead of appending

Choose **Update an existing row**, then set:

- **Find the row where this column…** → `Email`
- **…equals this value** → `{{ $json.body.email }}`
- **Add a new row if no match is found** → on, to get upsert behaviour

### One row per line item

Put a **Loop Over Items** step before the Sheets step, point it at the array
(`{{ $json.body.line_items }}`), and connect the Sheets step to the **Each item** output. Inside the loop, `{{ $json.sku }}` refers to the current element. The **Finished** output runs once at the end — handy for a summary email.

The **"Order with line items → one row each"** template does exactly this.

---

## Troubleshooting

| Message | Fix |
| --- | --- |
| `The caller does not have permission` | Share the spreadsheet with the service account email as Editor. |
| `Requested entity was not found` | Wrong spreadsheet id, or the tab name doesn't match — check capitalisation and spaces. |
| `Row 1 of "Sheet1" is empty` | Add a header row, or point **Header row number** at the row that has your titles. |
| `There is no column titled "X"` | Only on Update. The error lists the columns the sheet actually has. |
| `Google rejected the credentials` | Re-paste the JSON key; make sure it's the whole file. |
| Values arrive as text when you wanted numbers | They are sent with `USER_ENTERED`, so Sheets parses them as if typed. Check the cell's number format. |
| The step is slow | Sheets often takes several seconds. The step allows 60s; the run allows 5 minutes by default. |
