# Sending email reliably

There are two ways to send. On a hosted platform such as Railway, **the Gmail API is the one to use.**

| | **Gmail API** (recommended) | **SMTP** |
| --- | --- | --- |
| Network | HTTPS on port 443 | Ports 465 / 587, **often blocked by hosts** |
| Credential stored | An OAuth token, revocable at any time | Your mailbox password |
| Fails how | Immediately, with a clear message | Frequently by hanging until it times out |
| Daily limit | 2,000/day (Workspace) | Same |
| Setup | ~10 minutes, once | 2 minutes |

## Why SMTP goes quiet

Most platforms block outbound SMTP to stop spam. They usually do it by **dropping the packets rather than refusing the connection** — so there is nothing to react to, and the mail library simply waits. That is what a run stuck at "Running" with no email and no error actually is.

SVASTHA Automator now defends against this in three places: the SMTP transport has connection, greeting and socket timeouts; every step has a hard ceiling (90 seconds by default, adjustable per step under **Advanced**); and any run left orphaned is closed off with an explanation rather than sitting at "Running" forever.

But the real fix is not to depend on SMTP at all.

---

## Setting up the Gmail API

### 1. Create an OAuth client in Google Cloud

1. Go to <https://console.cloud.google.com> and select or create a project.
2. **APIs & Services → Library** → search **Gmail API** → **Enable**.
   (Also enable **Google Sheets API** if you write to spreadsheets — one connection covers both.)
3. **APIs & Services → OAuth consent screen**
   - User type: **Internal** if you have Google Workspace; otherwise **External**.
   - Fill in the app name and support email.
   - On External, add yourself under **Test users**.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Application type: **Web application**
   - Name: `SVASTHA Automator`
   - **Authorised redirect URIs** — this exact value, no trailing slash:

     ```
     https://your-app.up.railway.app/api/connections/oauth/google/callback
     ```

5. Copy the **Client ID** and **Client secret**.

### 2. Add the connection

**Connections → New connection → Google (Sign in)**

| Field | Value |
| --- | --- |
| Connection name | `Google — support@svastha.fit` |
| Client ID | from step 1 |
| Client secret | from step 1 |
| Send emails from | `support@svastha.fit` |
| Sender name | `Svastha` |

Save, then click **Connect with Google** on the card, choose the account, and approve. A popup handles it and closes itself.

Click the flask icon to test. It confirms which mailbox the connection can send as.

### 3. Point the Send Email step at it

Open the step, and under **Send using** pick the Google connection instead of SMTP. Everything else — recipients, subject, HTML body, attachments — is unchanged.

Leave **From address** blank on the step to use the connection's address.

---

## Sending from a service account instead

Useful when no human should own the mailbox. It needs Workspace admin rights.

1. Create the service account and JSON key as described in [GOOGLE-SHEETS.md](GOOGLE-SHEETS.md).
2. On the service account, note its **Client ID** (the long number under Details).
3. In the **Google Workspace admin console** → **Security → Access and data control → API controls → Domain-wide delegation → Add new**:
   - Client ID: the number from step 2
   - OAuth scopes:

     ```
     https://www.googleapis.com/auth/gmail.send,https://www.googleapis.com/auth/spreadsheets
     ```

4. In SVASTHA Automator, edit the service account connection and set **Send email as** to the mailbox it should send from, e.g. `support@svastha.fit`.

Without step 3 Google returns `unauthorized_client`, and the step will tell you so directly.

---

## Which "From" addresses are allowed

Google only lets you send as an address the account owns:

- The connected account itself — always fine.
- An alias, or another address added under Gmail → **Settings → Accounts → Send mail as** and verified.
- Any mailbox in your domain, when using a service account with domain-wide delegation.

Anything else is rejected with a `400`, and the step names the reason.

---

## Still want SMTP?

It is fully supported, and the timeouts mean it now fails quickly instead of hanging. Use an App Password as described in [GMAIL-SETUP.md](GMAIL-SETUP.md). If sends time out at exactly the same duration every time, your host is blocking the port — switch to the Gmail API.

To confirm from the Railway shell:

```bash
# A blocked port produces no output and simply hangs.
timeout 10 bash -c "</dev/tcp/smtp.gmail.com/587" && echo "587 reachable" || echo "587 blocked"
```

---

## Troubleshooting

| What you see | What it means |
| --- | --- |
| Run stuck at "Running", one step, no email | A step never returned. Now capped at 90s per step; switch the connection to the Gmail API. |
| `did not finish within 90s and was stopped` | The step hit its ceiling. Usually a blocked SMTP port. Raise the limit under **Advanced** only if the service is genuinely slow. |
| `unauthorized_client` | Service account without domain-wide delegation — see above. |
| `Request had insufficient scopes` | The connection predates Gmail support. Click **Reconnect with Google** and approve sending. |
| `did not return a refresh token` | The account was connected before. Remove the app at <https://myaccount.google.com/permissions> and reconnect. |
| `400` mentioning the From address | Google will not send as that address. Add it under *Send mail as*, or use the connected account. |
| Mail sends but lands in spam | Add SPF (`include:_spf.google.com`), DKIM and DMARC records for the domain. |
