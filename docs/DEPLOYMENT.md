# Deploying SVASTHA Automator to Railway

One Railway service runs everything: the REST API, the background worker, the cron scheduler and the React UI. You need a database alongside it.

Total time: about fifteen minutes.

---

## 1. Push the code to GitHub

```bash
cd svastha-automator
git init
git add .
git commit -m "SVASTHA Automator"
git branch -M main
git remote add origin https://github.com/<you>/svastha-automator.git
git push -u origin main
```

`node_modules`, `dist` and `.env` are already ignored.

---

## 2. Create the Railway project

1. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**.
2. Pick the repository. Railway finds the `Dockerfile` and `railway.json` and starts a build.

The first build takes 3–5 minutes. It will fail to boot until step 4 — that is expected.

---

## 3. Add a database

**Option A — Railway MongoDB (simplest)**

In the project canvas: **+ New** → **Database** → **Add MongoDB**.

**Option B — MongoDB Atlas (free tier, survives Railway changes)**

1. Create a free M0 cluster at [mongodb.com/atlas](https://www.mongodb.com/atlas).
2. Database Access → add a user.
3. Network Access → allow `0.0.0.0/0` (Railway egress IPs are not fixed).
4. Copy the connection string and append the database name:
   `mongodb+srv://user:pass@cluster.mongodb.net/svastha_automator`

Atlas is the safer choice if you want backups and a database that outlives this deployment.

---

## 4. Set the environment variables

Open the app service → **Variables** → **Raw Editor**, and paste:

```env
NODE_ENV=production
PORT=8080

# Railway MongoDB plugin:
MONGODB_URI=${{ MongoDB.MONGO_URL }}
# ...or Atlas:
# MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/svastha_automator

JWT_SECRET=<paste a 64-char hex string>
ENCRYPTION_KEY=<paste a different 64-char hex string>

APP_URL=https://<your-app>.up.railway.app
CORS_ORIGINS=https://<your-app>.up.railway.app

ENGINE_ENABLED=true
ENGINE_CONCURRENCY=5
RUN_RETENTION_DAYS=30
LOG_LEVEL=info
```

Generate the two secrets:

```bash
openssl rand -hex 32     # run twice, once per secret
```

or in Node:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> **`ENCRYPTION_KEY` is permanent.** Every SMTP password and API key is encrypted with it. Change it and you will have to re-enter every connection. Store both secrets in a password manager now.

If you want the owner account created automatically instead of through the setup screen, also add:

```env
BOOTSTRAP_EMAIL=you@yourdomain.com
BOOTSTRAP_PASSWORD=<a strong password>
BOOTSTRAP_NAME=Sumit
```

Remove `BOOTSTRAP_PASSWORD` after the first successful boot.

---

## 5. Generate the public domain

Service → **Settings** → **Networking** → **Generate Domain**. Railway gives you `https://something.up.railway.app`.

Put that value in `APP_URL` and `CORS_ORIGINS` (step 4) and redeploy. `APP_URL` is what the editor uses to show webhook URLs — get it wrong and the URLs it displays will point at the wrong host.

### Custom domain

Settings → Networking → **Custom Domain**, add `automator.yourdomain.com`, then create the CNAME record Railway shows you. Update `APP_URL` and `CORS_ORIGINS` to the custom domain afterwards.

---

## 6. First run

1. Open the domain. You should see the SVASTHA Automator sign-in screen.
2. Create the owner account.
3. **Connections** → add your SMTP details → **Test**.
4. **Workflows** → New workflow → build → **Test run** → **Live**.

Health check: `https://<your-domain>/api/health` should return `{"status":"ok","database":"connected",...}`.

---

## Migrating from Uncanny Automator

For each recipe you currently run in WordPress:

| In Uncanny Automator | In SVASTHA Automator |
| --- | --- |
| A webhook trigger | **Webhook** trigger — copy the new URL into whatever was calling WordPress |
| "Send data to webhook" action | **HTTP Request** step |
| "Send an email" action | **Send Email** step, pointed at an SMTP connection |
| Token/field mapping | **Edit Fields** step, or `{{ }}` expressions inline |
| Conditional recipes | **If / Else** or **Filter** |
| Scheduled recipes | **Schedule** trigger |

Practical order: build and test the new workflow while the old one is still running, switch the caller's URL, watch **Run history** for a day, then decommission the WordPress site.

---

## Operating notes

**Cost.** One Railway service plus MongoDB. With Atlas's free tier you're paying for the single service only.

**Scaling.** Raise `ENGINE_CONCURRENCY` for more parallel runs on one instance. To scale out, run a second service from the same repo with `ENGINE_ENABLED=true` and set `ENGINE_ENABLED=false` on the web-facing one — jobs are claimed atomically, so instances never collide.

**Run history.** `RUN_RETENTION_DAYS=30` expires old runs through a MongoDB TTL index. Set `0` to keep everything (watch your storage).

**Logs.** Railway → service → **Deployments** → **View Logs**. Structured JSON in production; set `LOG_LEVEL=debug` when you need detail.

**Backups.** Atlas snapshots the database. You can also export individual workflows as JSON from the workflow list — worth doing before a big change.

**Sleeping.** Don't enable serverless/sleep on this service. The scheduler needs to stay awake to fire cron triggers.

---

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `Missing required environment variable: MONGODB_URI` | The variable isn't set on the app service. Check the reference syntax `${{ MongoDB.MONGO_URL }}` matches your database service name. |
| Health check shows `database: disconnected` | Wrong connection string, or Atlas Network Access doesn't allow `0.0.0.0/0`. |
| Webhook URL in the editor points at localhost | `APP_URL` isn't set to the public domain. |
| SMTP test fails with a TLS error | Port 465 needs *Use TLS/SSL* on; port 587 needs it off. |
| Emails send but land in spam | Add SPF and DKIM records for the sending domain. |
| A schedule never fires | The workflow must be **Live**, and the service must not be sleeping. |
| Login says "session expired" straight away | `JWT_SECRET` changed between deploys — everyone must sign in again. |
| Saved connections stopped working | `ENCRYPTION_KEY` changed. Re-enter the credentials. |
