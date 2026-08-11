import nodemailer, { type Transporter } from "nodemailer";
import { sendViaGmailApi } from "../../lib/gmail";
import type { NodeDefinition } from "../types";

/** A Google connection sends through the Gmail API rather than SMTP. */
export function isGoogleCredential(
  credential: Record<string, unknown>,
): boolean {
  return Boolean(
    credential.refreshToken ||
    credential.serviceAccountJson ||
    credential.privateKey,
  );
}

const transporterCache = new Map<string, Transporter>();

function cacheKey(config: Record<string, unknown>): string {
  // Include password so that editing the connection creates a fresh transporter
  // rather than reusing a stale one from before the credential change.
  return [
    config.host,
    config.port,
    config.user,
    config.secure,
    config.password,
  ].join("|");
}

export function getTransporter(config: Record<string, any>): Transporter {
  const key = cacheKey(config);
  const cached = transporterCache.get(key);
  if (cached) return cached;

  const transporter = nodemailer.createTransport({
    host: String(config.host),
    port: Number(config.port ?? 465),
    secure: config.secure !== false,
    auth: config.user
      ? { user: String(config.user), pass: String(config.password ?? "") }
      : undefined,
    tls: { rejectUnauthorized: config.rejectUnauthorized !== false },
    pool: true,
    maxConnections: 3,

    /*
     * Timeouts are not optional here.
     *
     * Many hosts silently drop outbound traffic on ports 25/465/587 — the packet
     * disappears rather than being refused, so there is no connection error to
     * react to. Without these limits nodemailer waits indefinitely, the step
     * never returns, and the run sits at "Running" forever with no email sent.
     */
    connectionTimeout: Number(config.connectionTimeoutMs ?? 20_000),
    greetingTimeout: Number(config.greetingTimeoutMs ?? 20_000),
    socketTimeout: Number(config.socketTimeoutMs ?? 45_000),
  });

  transporterCache.set(key, transporter);
  return transporter;
}

export function clearTransporterCache(): void {
  for (const transporter of transporterCache.values()) transporter.close();
  transporterCache.clear();
}

function splitAddresses(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return String(value)
    .split(/[,;]/)
    .map((address) => address.trim())
    .filter(Boolean);
}

export const sendEmail: NodeDefinition = {
  type: "sendEmail",
  displayName: "Send Email",
  group: "action",
  version: 1,
  description:
    "Sends an email through any SMTP server. Supports HTML, plain text, CC/BCC and attachments by URL.",
  icon: "Mail",
  color: "#e11d48",
  inputs: 1,
  outputs: [{ name: "main", label: "Output" }],
  properties: [
    {
      name: "connection",
      label: "Send using",
      type: "connection",
      connectionType: "smtp,googleOAuth2,googleServiceAccount",
      required: true,
      description:
        "An SMTP server, or a Google connection to send through the Gmail API. Gmail is the more reliable choice — it uses ordinary HTTPS, so it keeps working when a host blocks outbound SMTP ports.",
    },
    {
      name: "to",
      label: "To",
      type: "string",
      required: true,
      placeholder: "{{ $json.email }}",
    },
    { name: "cc", label: "CC", type: "string" },
    { name: "bcc", label: "BCC", type: "string" },
    { name: "replyTo", label: "Reply-To", type: "string" },
    {
      name: "fromName",
      label: "From name (override)",
      type: "string",
      description: "Leave blank to use the connection default.",
    },
    {
      name: "fromEmail",
      label: "From address (override)",
      type: "string",
      description:
        "Must be an address your SMTP server is allowed to send from.",
    },
    {
      name: "subject",
      label: "Subject",
      type: "string",
      required: true,
      placeholder: "New enquiry from {{ $json.name }}",
    },
    {
      name: "format",
      label: "Body format",
      type: "select",
      default: "html",
      options: [
        { label: "HTML", value: "html" },
        { label: "Plain text", value: "text" },
        { label: "Both", value: "both" },
      ],
    },
    {
      name: "html",
      label: "HTML body",
      type: "code",
      language: "html",
      rows: 12,
      default:
        "<p>Hello {{ $json.name }},</p>\n<p>Thanks for getting in touch.</p>",
      displayOptions: { show: { format: ["html", "both"] } },
    },
    {
      name: "text",
      label: "Plain text body",
      type: "text",
      rows: 8,
      displayOptions: { show: { format: ["text", "both"] } },
    },
    {
      name: "attachments",
      label: "Attachments (URL)",
      type: "collection",
      default: [],
      fields: [
        { name: "filename", label: "File name", type: "string" },
        { name: "url", label: "File URL", type: "string" },
      ],
      description: "Files are fetched from the URL at send time.",
    },
  ],

  async execute(ctx) {
    const params = ctx.params as Record<string, any>;
    if (!params.connection)
      throw new Error("Choose how this email should be sent");

    const credential = await ctx.getConnection(String(params.connection));
    const usesGmail = isGoogleCredential(credential);

    const fromEmail =
      params.fromEmail || credential.fromEmail || credential.sendAsEmail;
    if (!fromEmail && !usesGmail) {
      throw new Error(
        "No from address configured on the connection or the step",
      );
    }
    const fromName = params.fromName || credential.fromName;

    const to = splitAddresses(params.to);
    if (to.length === 0) throw new Error("At least one recipient is required");

    const format = String(params.format ?? "html");
    const attachments = Array.isArray(params.attachments)
      ? (params.attachments as Array<{ filename?: string; url?: string }>)
          .filter((a) => a?.url)
          .map((a) => ({
            filename: a.filename || undefined,
            path: a.url as string,
          }))
      : [];

    const message = {
      from: fromEmail
        ? fromName
          ? `"${String(fromName).replace(/"/g, "")}" <${fromEmail}>`
          : String(fromEmail)
        : undefined,
      to,
      cc: splitAddresses(params.cc),
      bcc: splitAddresses(params.bcc),
      replyTo: params.replyTo ? String(params.replyTo) : undefined,
      subject: String(params.subject ?? ""),
      html:
        format === "html" || format === "both"
          ? String(params.html ?? "")
          : undefined,
      text:
        format === "text" || format === "both"
          ? String(params.text ?? "")
          : undefined,
      attachments,
    };

    if (usesGmail) {
      const result = await sendViaGmailApi(credential, message, ctx.signal);
      ctx.log(
        `Sent via the Gmail API to ${to.join(", ")} (${result.messageId})`,
      );

      return {
        kind: "output",
        data: {
          sent: true,
          transport: "gmail",
          messageId: result.messageId,
          threadId: result.threadId,
          accepted: result.accepted,
          rejected: [],
        },
      };
    }

    const info = await getTransporter(credential).sendMail(message);
    ctx.log(`Sent via SMTP to ${to.join(", ")} (${info.messageId})`);

    if (info.rejected?.length) {
      ctx.log(`Rejected: ${info.rejected.map(String).join(", ")}`);
    }

    return {
      kind: "output",
      data: {
        sent: true,
        transport: "smtp",
        messageId: info.messageId,
        accepted: info.accepted,
        rejected: info.rejected,
        response: info.response,
      },
    };
  },
};

export default sendEmail;
