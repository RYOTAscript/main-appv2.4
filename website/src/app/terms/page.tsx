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

      <h2>4. Refunds &amp; your right of withdrawal</h2>
      <p>
        main is a digital product that is delivered and usable{" "}
        <strong>immediately</strong> after purchase. Where you have a statutory
        right of withdrawal (for example, the 14-day right for consumers in the
        UK/EU), you expressly agree that we begin supplying the digital content
        immediately, and you acknowledge that you therefore{" "}
        <strong>lose that right of withdrawal</strong> once the download and your
        license key have been made available to you. You confirm this at
        checkout before payment.
      </p>
      <p>
        Beyond that, we still want you happy: if the app doesn&apos;t work for
        you and we can&apos;t sort it out, email us within{" "}
        <strong>14 days</strong> of purchase and we&apos;ll refund you and
        deactivate the license. No drama.
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
        Nothing in these terms excludes, restricts or modifies any consumer
        guarantee, right or remedy you have under the{" "}
        <strong>Australian Consumer Law</strong> or any other law that cannot
        legally be excluded.
      </p>

      <h2>7. Changes</h2>
      <p>
        We may update these terms as the app evolves. Material changes will be
        reflected by the “last updated” date above. Continued use after a change
        means you accept the revised terms.
      </p>

      <h2>8. Governing law &amp; who you&apos;re dealing with</h2>
      <p>
        main is operated by ryota, an independent developer based in Australia.
        These terms are governed by the laws of <strong>Australia</strong>, and
        you agree to the non-exclusive jurisdiction of the Australian courts —
        without depriving you of any mandatory consumer protection in your own
        country of residence. Full seller details are on our{" "}
        <a href="/legal">Legal Notice</a> page.
      </p>

      <h2>9. Trademarks &amp; third-party software</h2>
      <p>
        main is an independent product and is not affiliated with, endorsed by,
        or sponsored by Microsoft, Spotify, Discord, Riot Games (Valorant),
        TikTok / ByteDance, Valve (Steam), or Epic Games. All product names,
        logos and trademarks are the property of their respective owners and are
        used for identification purposes only. main bundles third-party
        open-source software (including FFmpeg, licensed under the GPL v3) — see
        the THIRD-PARTY-NOTICES file included with the app for the full licenses
        and source offers.
      </p>

      <h2>10. Contact</h2>
      <p>
        Questions? Reach out via the support link in the footer, or email{" "}
        <a href="mailto:mainappsupport@gmail.com">mainappsupport@gmail.com</a>.
        main is made by ryota — see the <a href="/legal">Legal Notice</a> for
        seller details.
      </p>
    </LegalPage>
  );
}
