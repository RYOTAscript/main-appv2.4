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

      <h2>What the desktop app sends us</h2>
      <p>
        When main starts, it checks your license with our server. That check
        sends three things, all of them there to stop one purchase being shared
        across the internet — none of it is used to track you or build a profile:
      </p>
      <ul>
        <li>
          <strong>A device fingerprint.</strong> A one-way hash of an identifier
          your operating system already assigns to the machine (the
          <em> MachineGuid</em> on Windows, the <em>hardware UUID</em> on macOS).
          We store the hash, never the original, and it can&apos;t be reversed
          into anything about you or your hardware. It exists so a license can be
          tied to your computers rather than copied freely.
        </li>
        <li>
          <strong>Your computer&apos;s name</strong> — whatever you or your OS
          called it (e.g. &ldquo;Ryan&apos;s PC&rdquo;). It&apos;s shown in the
          device list on your Account page so you can tell your machines apart
          when freeing a slot. Nothing else reads it.
        </li>
        <li>
          <strong>Your IP address</strong>, seen in the request like any web
          request. We use it only to rate-limit the endpoint against abuse. It is
          not stored against your account.
        </li>
      </ul>
      <p>
        If a second or later device activates on your license, we email the
        account owner so you find out if someone else is using your key.
      </p>

      <h2>How long we keep it</h2>
      <p>
        Your account, license and device records are kept while your account
        exists — the license is lifetime, so the record has to outlive any
        particular device. Purchase records are kept for as long as tax and
        accounting rules require. Delete your account and all of it goes, as
        described under <em>Your choices</em> below.
      </p>

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
        Apart from the license check above, the main desktop app stores its
        settings, tokens, and caches <strong>locally on your own computer</strong>{" "}
        (your AppData folder on Windows, Application Support on macOS). Things
        like Spotify tokens, your clipboard history and your widget configuration
        never leave your machine except to talk to the services you connect
        yourself (e.g. Spotify, weather). Spotify tokens and clipboard history
        are encrypted at rest using your operating system&apos;s own key store.
      </p>

      <h2>Your choices</h2>
      <p>
        You can sign out at any time, and you can delete your account yourself
        from your{" "}
        <a href="/account">Account page</a> (&ldquo;Danger zone&rdquo;) — or ask
        us via the support link in the footer. Deleting your account permanently
        removes your profile, license, and purchase records from our database.
      </p>

      <h2>Your rights</h2>
      <p>
        Depending on where you live — the UK/EU (GDPR), California (CCPA/CPRA),
        Australia and elsewhere — you have the right to access the data we hold
        about you, correct it, have it deleted, object to how we use it, and
        receive a copy in a portable form. You can exercise all of these by
        emailing{" "}
        <a href="mailto:mainappsupport@gmail.com">mainappsupport@gmail.com</a>,
        and deletion is available immediately and without asking us from your{" "}
        <a href="/account">Account page</a>.
      </p>
      <p>
        Where the GDPR applies, our legal basis is <em>contract</em> — we need
        your email to give you an account, and the device fingerprint to deliver
        the licensed software you bought — plus our <em>legitimate interest</em>{" "}
        in preventing license fraud. We don&apos;t rely on consent for anything
        described here, and we don&apos;t sell or share personal information as
        those terms are defined under the CCPA/CPRA.
      </p>
      <p>
        The data controller is <strong>ryota</strong>, an independent developer
        based in Australia — full seller details are on the{" "}
        <a href="/legal">Legal Notice</a> page. Our processors are Google
        (sign-in), PayPal (payment), Vercel (hosting) and our database host;
        using them means your data may be handled outside your own country. If
        you&apos;re in the UK/EU and think we&apos;ve got something wrong, you
        can also complain to your local data protection authority.
      </p>

      <h2>Changes</h2>
      <p>
        If this policy changes, we&apos;ll update the “last updated” date above.
      </p>
    </LegalPage>
  );
}
