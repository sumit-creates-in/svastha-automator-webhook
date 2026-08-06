# Connecting Google Workspace (Gmail) to SVASTHA Automator

Gmail is connected as an ordinary **SMTP connection** — the same form every email step uses. There are two ways to authenticate, and with a paid Workspace account you can use either.

| | **App Password** | **SMTP Relay** |
| --- | --- | --- |
| Setup effort | 5 minutes, no admin needed beyond 2-Step Verification | 15 minutes, admin console + up to 24h propagation |
| Daily limit | ~2,000 recipients / day | 10,000 messages / day per user |
| "From" address | Only the authenticated mailbox or a verified *Send mail as* alias | **Any** address in your domain |
| Best for | Getting running today; internal notifications | Production automation, sending as `no-reply@`, `orders@`, etc. |

**Recommendation:** start with an App Password to prove the workflow end to end, then switch to SMTP Relay before you go live. Switching later is a two-field edit on the same connection.

---

## Option A — App Password (start here)

### 1. Turn on 2-Step Verification

App Passwords only exist on accounts with 2SV enabled.

1. Go to <https://myaccount.google.com/security>
2. Under **How you sign in to Google**, open **2-Step Verification** and complete the setup.

> If your Workspace admin has enforced 2SV already, skip this.

### 2. Generate the App Password

1. Go to <https://myaccount.google.com/apppasswords>
2. Name it `SVASTHA Automator` and click **Create**.
3. Copy the **16-character password**. Google shows it once. Spaces in it are cosmetic — type it with or without, both work.

> **"App passwords" page not available?** Your Workspace admin has disabled it. In the Admin console: **Security → Authentication → 2-Step Verification → Allow users to turn on App Passwords**. Or use Option B instead, which doesn't depend on this.

### 3. Add the connection in SVASTHA Automator

**Connections → New connection → SMTP (Email)**

| Field | Value |
| --- | --- |
| Connection name | `Gmail — <your address>` |
| SMTP host | `smtp.gmail.com` |
| Port | `465` |
| Use TLS/SSL (port 465) | **ON** |
| Username | your full Workspace address, e.g. `sumit@yourdomain.com` |
| Password | the 16-character App Password (**not** your Google password) |
| Default from name | e.g. `Sumit` or your company name |
| Default from address | the same address as the username |
| Verify TLS certificate | **ON** |

Click **Save**, then the **flask icon** to test. A green "Connection works" means Gmail accepted the credentials.

> Prefer port 587? Set Port to `587` and turn **Use TLS/SSL off** — the connection then upgrades via STARTTLS. Use this if your host blocks 465.

---

## Option B — SMTP Relay (production)

This is the Workspace feature built for exactly this job: an application sending mail on your domain's behalf.

### 1. Configure the relay in the Admin console

1. Sign in at <https://admin.google.com> as a super admin.
2. Go to **Apps → Google Workspace → Gmail → Routing**.
3. Scroll to **SMTP relay service** → **Configure**.
4. Fill it in:

   | Setting | Choose |
   | --- | --- |
   | Description | `SVASTHA Automator` |
   | Allowed senders | **Only addresses in my domains** |
   | Only accept mail from specified IP addresses | Leave **unchecked** (Railway's egress IPs are not fixed) |
   | Require SMTP Authentication | **Checked** |
   | Require TLS encryption | **Checked** |

5. **Save.** Changes can take up to 24 hours to propagate — usually minutes.

> This setting can only be added at the top-level organisation, and needs the *Gmail Settings* admin privilege.

### 2. Pick an account to authenticate as

The relay still authenticates as a real user. Either:

- **A dedicated user** such as `automation@yourdomain.com` — cleanest, but it's a paid seat; or
- **Your own account** — fine for a small team, and you can still send *as* any domain address.

Generate an App Password for whichever account you choose (steps A1–A2 above).

### 3. Add the connection

**Connections → New connection → SMTP (Email)**

| Field | Value |
| --- | --- |
| Connection name | `Google Workspace Relay` |
| SMTP host | `smtp-relay.gmail.com` |
| Port | `587` |
| Use TLS/SSL (port 465) | **OFF** (587 uses STARTTLS) |
| Username | `automation@yourdomain.com` |
| Password | that account's App Password |
| Default from name | e.g. `Your Company` |
| Default from address | **any** address in your domain, e.g. `no-reply@yourdomain.com` |
| Verify TLS certificate | **ON** |

Save and **Test**.

---

## Make your mail land in the inbox

Google Workspace handles DKIM and SPF for you *if* the DNS is set up. Check all three at your domain registrar:

| Record | Type | Value |
| --- | --- | --- |
| SPF | TXT on `@` | `v=spf1 include:_spf.google.com ~all` |
| DKIM | TXT on `google._domainkey` | Generate in **Admin console → Apps → Google Workspace → Gmail → Authenticate email** |
| DMARC | TXT on `_dmarc` | `v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com` |

Only one SPF record is allowed per domain — if you already have one, merge `include:_spf.google.com` into it rather than adding a second.

---

## Using it in a workflow

1. Open a workflow → **Add step → Send Email**.
2. **SMTP connection** → pick the Gmail connection you just made.
3. Fill the rest with expressions:

   - **To**: `{{ $json.email }}`
   - **Subject**: `New enquiry from {{ $json.name }}`
   - **HTML body**:
     ```html
     <p>Hello {{ $fn.title($json.name) }},</p>
     <p>Thanks for getting in touch — we'll reply within one business day.</p>
     ```
4. **Test run**, then open **Run details** to see the `messageId` Gmail returned.

Leave **From name** and **From address** blank on the step to use the connection defaults, or fill them to override per email.

---

## Troubleshooting

| Error | What it means |
| --- | --- |
| `535-5.7.8 Username and Password not accepted` | You used your normal Google password. Use the 16-character App Password. |
| `534-5.7.9 Application-specific password required` | 2-Step Verification is on but you're not using an App Password. |
| `550-5.7.1 Invalid credentials for relay` | SMTP relay isn't configured for this domain yet, or hasn't propagated. Re-check step B1. |
| `550-5.7.1 Mail relay denied` | The From address isn't in an allowed domain. Set *Allowed senders* to **Only addresses in my domains**. |
| Connection times out on port 465 | Your host blocks 465. Use port `587` with **Use TLS/SSL off**. |
| Mail sends, but From is rewritten to your own address | Expected with `smtp.gmail.com`. Add the address under Gmail → Settings → *Send mail as*, or move to SMTP relay. |
| `Daily user sending quota exceeded` | You've hit the 2,000/day cap. Move to SMTP relay (10,000/day). |
| Everything lands in spam | SPF/DKIM/DMARC missing — see the DNS table above. |

---

## Security notes

- The App Password is encrypted with AES-256-GCM before it touches MongoDB, and is never sent back to the browser in full.
- An App Password grants full mail access to that account. Revoke it any time at <https://myaccount.google.com/apppasswords> — the connection stops working immediately, nothing else is affected.
- If you ever change `ENCRYPTION_KEY` on the server, re-enter this connection.

---

## Want OAuth instead?

A Gmail **OAuth 2.0** connection (no App Password, revocable from the Workspace admin console, no 2SV dependency) is a natural next addition. It needs a Google Cloud project, a consent screen and a refresh-token flow — roughly one new connection type plus a callback route. Ask when you want it built.
