import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/LegalPage";

export const metadata: Metadata = {
  title: "Legal Notice · main",
};

export default function LegalNoticePage() {
  return (
    <LegalPage label="Legal" title="Legal Notice" updated="August 2026">
      <h2>Who operates main</h2>
      <p>
        <strong>main</strong> is an independent software product operated by{" "}
        <strong>ryota</strong>, a sole developer based in{" "}
        <strong>Australia</strong>. main is not a registered company; it is run
        by an individual.
      </p>

      <h2>Contact</h2>
      <p>
        The fastest way to reach us is email:{" "}
        <a href="mailto:mainappsupport@gmail.com">mainappsupport@gmail.com</a>.
        We usually reply within a day. You can also use the Support link in the
        footer. Our country of establishment is Australia.
      </p>

      <h2>Governing law</h2>
      <p>
        These terms, and any dispute or claim arising out of or in connection
        with main (including its purchase and use), are governed by the laws of{" "}
        <strong>Australia</strong>, and you agree to submit to the
        non-exclusive jurisdiction of the Australian courts. This does not
        deprive you of any protection you have under the mandatory consumer laws
        of your own country of residence.
      </p>

      <h2>Your consumer rights</h2>
      <p>
        Our goods and services come with guarantees that cannot be excluded
        under the <strong>Australian Consumer Law</strong>. Nothing in our{" "}
        <a href="/terms">Terms of Service</a> — including the &ldquo;as is&rdquo;
        and liability wording — limits or excludes any rights or remedies you
        have under the Australian Consumer Law or any other law that cannot
        legally be excluded.
      </p>

      <h2>Related policies</h2>
      <p>
        See our <a href="/terms">Terms of Service</a> for the license and refund
        terms, and our <a href="/privacy">Privacy Policy</a> for how we handle
        your data.
      </p>
    </LegalPage>
  );
}
