import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/LegalPage";

export const metadata: Metadata = {
  title: "Privacy Policy · main",
};

export default function PrivacyPage() {
  return (
    <LegalPage label="Legal" title="Privacy Policy" updated="August 2026">
      <h2>The short version</h2>
      <p>
        We collect as little as possible: enough to sign you in with Google, take
        one $5 payment through PayPal, and give you a license key. We don&apos;t
        sell your data, and we don&apos;t track you around the web.
      </p>

      <h2>What we store</h2>
      <ul>
        <li>
          <strong>Google account basics</strong> — your name, email address, and
          avatar, used only to create your account and sign you in.
        </li>
        <li>
          <strong>Your license &amp; purchase record</strong> — a license key,
          the PayPal order/payment id, the amount, and the date, so we can
          show your status and let you re-download.
        </li>
        <li>
          <strong>A session cookie</strong> — set by NextAuth to keep you signed
          in. That&apos;s the only cookie we rely on.
        </li>
      </ul>

      <h2>What we don&apos;t store</h2>
      <p>
        We never see or store your card details. Payment information is handled
        entirely by <strong>PayPal</strong> under{" "}
        <a
          href="https://www.paypal.com/us/legalhub/privacy-full"
          target="_blank"
          rel="noreferrer"
        >
          their privacy policy
        </a>
        . Authentication is handled by{" "}
        <a href="https://policies.google.com/privacy" target="_blank" rel="noreferrer">
          Google
        </a>
        ; we only receive the basic profile fields listed above.
      </p>

      <h2>How we use it</h2>
      <p>
        Your data is used solely to operate main&apos;s account, license, and
        download features. We may email you about your purchase (like a receipt
        or a refund). We don&apos;t run ad networks or third-party analytics that
        profile you.
      </p>

      <h2>The desktop app</h2>
      <p>
        The main desktop app stores its settings, tokens, and caches{" "}
        <strong>locally on your PC</strong> (in your AppData folder). Things like
        Spotify tokens and your widget configuration never leave your machine
        except to talk to the services you connect (e.g. Spotify, weather).
      </p>

      <h2>Your choices</h2>
      <p>
        You can sign out at any time, and you can delete your account yourself
        from your{" "}
        <a href="/account">Account page</a> (&ldquo;Danger zone&rdquo;) — or ask
        us via the support link in the footer. Deleting your account permanently
        removes your profile, license, and purchase records from our database.
      </p>

      <h2>Changes</h2>
      <p>
        If this policy changes, we&apos;ll update the “last updated” date above.
      </p>
    </LegalPage>
  );
}
