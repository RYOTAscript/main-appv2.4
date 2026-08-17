/**
 * Transactional email — dependency-free, via the Resend HTTP API.
 *
 * Env-gated: if RESEND_API_KEY (and EMAIL_FROM) aren't set, sending is a no-op
 * that logs, so the app works fine before email is wired up and never blocks a
 * purchase on an email failure. Set both to turn it on.
 *
 *   RESEND_API_KEY=re_...          (https://resend.com)
 *   EMAIL_FROM="main <hi@your-domain>"
 */
import { SITE_URL } from "@/lib/site";

export function isEmailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

type SendArgs = { to: string; subject: string; html: string; text: string };

async function send({ to, subject, html, text }: SendArgs): Promise<boolean> {
  if (!isEmailConfigured()) {
    console.warn("[email] not configured — skipping send to", to);
    return false;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: process.env.EMAIL_FROM, to, subject, html, text }),
      cache: "no-store",
    });
    if (!res.ok) {
      console.error("[email] send failed", res.status, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error("[email] send error", err);
    return false;
  }
}

/**
 * Purchase receipt + license key delivery. Best-effort: returns false (never
 * throws) so provisioning is never rolled back by an email problem.
 */
export async function sendLicenseEmail(to: string, licenseKey: string): Promise<boolean> {
  const downloadUrl = `${SITE_URL}/download`;
  const accountUrl = `${SITE_URL}/account`;
  const subject = "Your main license key";
  const text = [
    "Thanks for buying main!",
    "",
    `Your license key: ${licenseKey}`,
    "",
    `Download for Windows: ${downloadUrl}`,
    `Your account: ${accountUrl}`,
    "",
    "Keep this key safe — you can also find it any time on your account page.",
    "Questions? Reply to this email or contact mainappsupport@gmail.com.",
  ].join("\n");
  const html = `
    <div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;color:#111">
      <h1 style="font-size:20px;margin:0 0 12px">Thanks for buying main 🎉</h1>
      <p style="color:#444;font-size:14px;line-height:1.6">Your lifetime license is ready. Here's your key:</p>
      <p style="font-family:ui-monospace,Menlo,monospace;font-size:16px;font-weight:600;background:#f4f4f5;border:1px solid #e4e4e7;border-radius:10px;padding:12px 16px;letter-spacing:1px">${licenseKey}</p>
      <p style="margin:20px 0">
        <a href="${downloadUrl}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 18px;border-radius:10px">Download for Windows</a>
      </p>
      <p style="color:#666;font-size:13px;line-height:1.6">You can also find your key any time on your <a href="${accountUrl}" style="color:#111">account page</a>. Questions? Just reply, or email mainappsupport@gmail.com.</p>
    </div>`;
  return send({ to, subject, html, text });
}

/**
 * Security alert: a new device just activated the user's license. Best-effort —
 * only sent when email is configured, and only for the 2nd+ device (the first
 * activation after purchase isn't noteworthy). Helps a user notice if their key
 * is being shared or was stolen, and points them at the reset control.
 */
export async function sendNewDeviceEmail(
  to: string,
  device: { name: string | null; shortId: string },
): Promise<boolean> {
  const accountUrl = `${SITE_URL}/account`;
  const label = device.name ? `${device.name} (#${device.shortId})` : `#${device.shortId}`;
  const when = new Date().toLocaleString("en-US", { timeZone: "UTC", timeZoneName: "short" });
  const subject = "New device on your main license";
  const text = [
    "A new device just started using your main license:",
    "",
    `  Device: ${label}`,
    `  When:   ${when}`,
    "",
    "If this was you, no action is needed.",
    "If you don't recognise it, open your account page and use “Reset devices”",
    `to sign every device out, then sign back in on the ones you keep:`,
    `  ${accountUrl}`,
    "",
    "Questions? Reply here or email mainappsupport@gmail.com.",
  ].join("\n");
  const html = `
    <div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;color:#111">
      <h1 style="font-size:20px;margin:0 0 12px">New device on your license</h1>
      <p style="color:#444;font-size:14px;line-height:1.6">A new device just started using your main license:</p>
      <p style="font-family:ui-monospace,Menlo,monospace;font-size:14px;background:#f4f4f5;border:1px solid #e4e4e7;border-radius:10px;padding:12px 16px">
        <strong>${label}</strong><br/><span style="color:#666">${when}</span>
      </p>
      <p style="color:#444;font-size:14px;line-height:1.6">If this was you, you can ignore this email. If you don't recognise it, reset your devices to sign everyone out:</p>
      <p style="margin:20px 0">
        <a href="${accountUrl}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 18px;border-radius:10px">Manage devices</a>
      </p>
      <p style="color:#666;font-size:13px;line-height:1.6">Questions? Just reply, or email mainappsupport@gmail.com.</p>
    </div>`;
  return send({ to, subject, html, text });
}
