import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Support - Ghola",
  description:
    "Support, privacy, payment, deletion, and abuse reporting paths for Ghola.",
};

export default function SupportPage() {
  return (
    <div className="min-h-screen bg-[#08090d] pt-16">
      <article className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8 py-20 text-[#c9d1de]">
        <header className="mb-12">
          <p className="mb-3 text-sm font-medium uppercase tracking-[0.18em] text-[#3da8ff]">
            Ghola Support
          </p>
          <h1 className="text-4xl md:text-5xl font-medium tracking-tight text-[#eef1f8] leading-[1.05]">
            Support, privacy, payments, and abuse reports.
          </h1>
          <p className="mt-4 text-[15px] leading-relaxed text-[#8b95a8]">
            For TestFlight and production support, use the paths below. Do not
            send private keys, seed phrases, recovery material, or one-time
            codes to Ghola.
          </p>
        </header>

        <Section title="General Support">
          <p>
            For account access, sign-in issues, app crashes, wallet display
            errors, or TestFlight feedback, email{" "}
            <SupportEmail label="privacy@ghola.xyz" /> with the device model,
            app version, approximate time of the issue, and screenshots if you
            choose to include them.
          </p>
        </Section>

        <Section title="Privacy And Deletion Requests">
          <p>
            To ask privacy questions, request a copy of your data, or request
            account deletion, email <SupportEmail label="privacy@ghola.xyz" />.
            Ghola will verify account ownership before deleting account-linked
            data. Public blockchain records, including Solana transactions, are
            not controlled by Ghola and cannot be deleted from the chain.
          </p>
          <p>
            See the{" "}
            <Link href="/privacy" className="text-[#3da8ff] hover:underline">
              Privacy Policy
            </Link>{" "}
            and{" "}
            <Link href="/terms" className="text-[#3da8ff] hover:underline">
              Terms
            </Link>{" "}
            for the current service terms and data practices.
          </p>
        </Section>

        <Section title="Payment And USDC Issues">
          <p>
            For subscription billing, failed payment, wallet provisioning, or
            public USDC transfer issues, email{" "}
            <SupportEmail label="privacy@ghola.xyz" />. Include the network
            shown in the app, the approximate amount, and the transaction
            signature if one was shown.
          </p>
          <p>
            Ghola does not ask for seed phrases or private keys. Public Solana
            USDC transfers reveal sender, recipient, amount, and timing on
            chain; they are not shielded.
          </p>
        </Section>

        <Section title="Native Messaging Abuse Reports">
          <p>
            Ghola-native messages are encrypted end to end by default. Ghola
            Cloud relays ciphertext and cannot read message text. To report
            abuse, use the in-app report control or email{" "}
            <SupportEmail label="privacy@ghola.xyz" />.
          </p>
          <p>
            Include the sender DID, relay message ID, timestamp, and only the
            message text or screenshots that you choose to disclose. The app
            also lets you block a sender locally so new ciphertext from that
            DID is ignored.
          </p>
        </Section>

        <Section title="Security Reports">
          <p>
            For security vulnerabilities, account takeover concerns, or
            suspected key exposure, email <SupportEmail label="privacy@ghola.xyz" />{" "}
            with the subject line "Security report". Do not include exploit
            code that affects real users without first coordinating disclosure.
          </p>
        </Section>

        <Section title="Legal">
          <p>
            Legal questions about the Terms can be sent to{" "}
            <a
              href="mailto:legal@ghola.xyz"
              className="text-[#3da8ff] hover:underline"
            >
              legal@ghola.xyz
            </a>
            .
          </p>
        </Section>
      </article>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-10">
      <h2 className="text-xl md:text-2xl font-medium text-[#eef1f8] mb-4">
        {title}
      </h2>
      <div className="space-y-3 text-[15px] leading-relaxed text-[#c9d1de]">
        {children}
      </div>
    </section>
  );
}

function SupportEmail({ label }: { label: string }) {
  return (
    <a href={`mailto:${label}`} className="text-[#3da8ff] hover:underline">
      {label}
    </a>
  );
}
