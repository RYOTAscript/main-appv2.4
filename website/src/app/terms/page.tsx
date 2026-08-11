import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/LegalPage";

export const metadata: Metadata = {
  title: "Terms of Service · main",
};

export default function TermsPage() {
  return (
    <LegalPage label="Legal" title="Terms of Service" updated="August 2026">
      <h2>1. The license you&apos;re buying</h2>
      <p>
        When you purchase <strong>main</strong>, you receive a{" "}
        <strong>one-time, lifetime license</strong> to install and use the app
        on your own Windows PCs. The license is granted to a single user — you —
        and includes free updates across the v3.x line.
      </p>

      <h2>2. Single user, no reselling</h2>
      <p>
        Your license key is personal. You may not sell, rent, sublicense, share,
        or redistribute your key or the installer, and you may not present main
        or its assets as your own product. We may deactivate keys that are shared
        publicly or abused.
      </p>

      <h2>3. Payment</h2>
      <p>
        Payments are processed by <strong>PayPal</strong>. We never see or store
        your full card details — PayPal handles the transaction and returns only
        a confirmation, from which we provision your license. The price is a
        one-time <strong>$5.00 USD</strong>; there is no subscription and nothing
        recurring.
      </p>

      <h2>4. Refunds</h2>
      <p>
        Because main is a digital product delivered instantly, sales are
        generally final. That said, if the app doesn&apos;t work for you and we
        can&apos;t sort it out, email us within <strong>14 days</strong> of
        purchase and we&apos;ll refund you and deactivate the license. No drama.
      </p>

      <h2>5. Acceptable use</h2>
      <p>
        main automates parts of your own Windows system (media keys, FPS tweaks,
        macros, controller input, and more). You&apos;re responsible for how you
        use it — including complying with the terms of any games or services you
        run alongside it. Some anti-cheat systems may dislike overlays or virtual
        input; use those features at your own discretion.
      </p>

      <h2>6. No warranty</h2>
      <p>
        main is provided <strong>“as is”</strong>, without warranties of any
        kind. To the maximum extent permitted by law, we aren&apos;t liable for
        any indirect or consequential damages arising from your use of the app.
      </p>

      <h2>7. Changes</h2>
      <p>
        We may update these terms as the app evolves. Material changes will be
        reflected by the “last updated” date above. Continued use after a change
        means you accept the revised terms.
      </p>

      <h2>8. Contact</h2>
      <p>
        Questions? Reach out via the support link in the footer. main is made by
        ryota and isn&apos;t affiliated with Spotify, Discord, or Microsoft.
      </p>
    </LegalPage>
  );
}
