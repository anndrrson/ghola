import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy — Ghola",
  description:
    "How Ghola collects, uses, stores, and protects information across the Ghola web application, mobile app, and APIs.",
};

const EFFECTIVE_DATE = "July 14, 2026";

export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen bg-[#08090d] pt-16">
      <article className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8 py-20 text-[#c9d1de]">
        <header className="mb-12">
          <h1 className="text-4xl md:text-5xl font-medium tracking-tight text-[#eef1f8] leading-[1.05]">
            Privacy Policy
          </h1>
          <p className="mt-4 text-sm text-[#8b95a8]">
            Effective date: {EFFECTIVE_DATE}
          </p>
        </header>

        <Section title="1. Introduction">
          <p>
            This Privacy Policy describes how Ghola (&ldquo;Ghola,&rdquo;
            &ldquo;we,&rdquo; &ldquo;us,&rdquo; or &ldquo;our&rdquo;) collects,
            uses, stores, and shares information when you use the Ghola web
            application at ghola.xyz, the Ghola mobile application, the Ghola
            APIs, and any related services (collectively, the
            &ldquo;Services&rdquo;).
          </p>
          <p>
            By using the Services, you agree to the collection and use of
            information in accordance with this policy. If you do not agree,
            please do not use the Services.
          </p>
        </Section>

        <Section title="2. Information we collect">
          <h3 className="text-[#eef1f8] font-medium mt-6 mb-2">
            2.1 Account information
          </h3>
          <p>
            When you create an account we collect your email address, a hashed
            password (or your sign-in identifier from Google or Apple if you
            use those providers), your display name, and any profile metadata
            you choose to provide.
          </p>

          <h3 className="text-[#eef1f8] font-medium mt-6 mb-2">
            2.2 Wallet and on-chain data
          </h3>
          <p>
            Ghola integrates with Solana wallets, including the Solana Seeker
            Seed Vault and Mobile Wallet Adapter. We collect your public wallet
            address and on-chain transaction signatures. We do not collect or
            store your private keys, seed phrase, or recovery material — those
            remain on your device.
          </p>

          <h3 className="text-[#eef1f8] font-medium mt-6 mb-2">
            2.3 Trading accounts and execution data
          </h3>
          <p>
            When you connect a venue or trading authority, we process venue
            account identifiers, scoped API credentials or delegated signer
            handles, authorization commitments, trading plans, risk settings,
            orders, fills, positions, and receipt metadata. Supported venues
            receive the account and order information needed to execute the
            action you approved. Do not provide Ghola with a seed phrase or an
            unrestricted withdrawal credential.
          </p>

          <h3 className="text-[#eef1f8] font-medium mt-6 mb-2">
            2.4 Connected accounts
          </h3>
          <p>
            If you connect Gmail, Google Calendar, or other third-party
            services, we receive OAuth tokens scoped to the permissions you
            grant. These tokens are encrypted at rest using AES-256-GCM. We
            access only the data needed to perform tasks you explicitly
            request.
          </p>

          <h3 className="text-[#eef1f8] font-medium mt-6 mb-2">
            2.5 Conversation and task content
          </h3>
          <p>
            When you chat with Ghola or assign it tasks (placing a phone call,
            drafting an email, controlling a device, querying a model) we
            collect the inputs you provide, the outputs generated, and metadata
            about the request. This is required to fulfil the request and to
            display your task history back to you.
          </p>

          <h3 className="text-[#eef1f8] font-medium mt-6 mb-2">
            2.6 Voice calls
          </h3>
          <p>
            When you ask Ghola to place a phone call on your behalf, the call
            is placed through our voice provider (Bland AI). Call audio,
            transcripts, and metadata may be processed and retained by both
            Ghola and the voice provider for the purpose of completing the
            task and providing you a record. You are responsible for complying
            with all applicable call-recording and consent laws in your
            jurisdiction.
          </p>

          <h3 className="text-[#eef1f8] font-medium mt-6 mb-2">
            2.7 Device and usage data
          </h3>
          <p>
            On mobile we collect device identifiers, operating system version,
            app version, and crash reports. The Ghola mobile app uses the
            Android Accessibility Service when you grant it; this allows the
            agent to read on-screen content and perform actions in apps you
            choose. Accessibility data is processed locally on your device and
            is only transmitted to our servers when required to fulfil a task
            you initiated.
          </p>

          <h3 className="text-[#eef1f8] font-medium mt-6 mb-2">
            2.8 Payment information
          </h3>
          <p>
            Subscription payments are processed by Stripe. We do not store your
            full card number. We retain the last four digits, card brand,
            customer ID, and subscription status returned by Stripe. USDC
            settlement transactions occur on the Solana blockchain and are
            publicly visible by their nature.
          </p>
        </Section>

        <Section title="3. How we use information">
          <ul className="list-disc pl-6 space-y-2">
            <li>To operate, maintain, and improve the Services.</li>
            <li>
              To execute the tasks you assign to your agent (calls, emails,
              device actions, model queries, on-chain transactions).
            </li>
            <li>To authenticate you and secure your account.</li>
            <li>
              To process payments, settle USDC, and bill subscription tiers.
            </li>
            <li>
              To validate, submit, reconcile, and audit trading instructions
              you approve, including enforcement of configured risk checks.
            </li>
            <li>
              To send you transactional notifications (task completions, call
              outcomes, billing receipts).
            </li>
            <li>To detect, investigate, and prevent fraud or abuse.</li>
            <li>To comply with legal obligations.</li>
          </ul>
          <p className="mt-4">
            We do not sell your personal information. We do not use your
            conversation content to train third-party foundation models without
            your explicit, opt-in consent.
          </p>
        </Section>

        <Section title="4. Third-party processors">
          <p>
            To deliver the Services we share limited information with the
            following processors:
          </p>
          <ul className="list-disc pl-6 space-y-2">
            <li>
              <strong className="text-[#eef1f8]">Supabase</strong> — managed
              Postgres database hosting.
            </li>
            <li>
              <strong className="text-[#eef1f8]">Neon</strong> — managed
              Postgres database hosting for supported production services.
            </li>
            <li>
              <strong className="text-[#eef1f8]">Hyperliquid, Coinbase, and supported Solana applications</strong>{" "}
              — market data and execution when you connect and approve a venue.
            </li>
            <li>
              <strong className="text-[#eef1f8]">Phala Cloud</strong> —
              confidential worker infrastructure when that execution mode is enabled.
            </li>
            <li>
              <strong className="text-[#eef1f8]">Anthropic</strong> — language
              model inference (Claude).
            </li>
            <li>
              <strong className="text-[#eef1f8]">Together.ai</strong> —
              language model inference for marketplace models.
            </li>
            <li>
              <strong className="text-[#eef1f8]">Bland AI</strong> — outbound
              voice calls.
            </li>
            <li>
              <strong className="text-[#eef1f8]">Google</strong> — Gmail and
              Calendar APIs (only when you connect them).
            </li>
            <li>
              <strong className="text-[#eef1f8]">Stripe</strong> — subscription
              billing and payment processing.
            </li>
            <li>
              <strong className="text-[#eef1f8]">Solana RPC providers</strong>{" "}
              — broadcasting and reading on-chain transactions.
            </li>
            <li>
              <strong className="text-[#eef1f8]">Vercel</strong> — web hosting
              and edge delivery.
            </li>
          </ul>
          <p className="mt-4">
            Each processor handles data under its own privacy terms. We
            transmit only the minimum data required to provide the integration
            you have requested.
          </p>
        </Section>

        <Section title="5. Data retention">
          <p>
            We retain account data for as long as your account is active. You
            may delete your account at any time from the in-app settings; when
            you do so we delete or anonymise associated personal data within 30
            days, except where retention is required for legal, accounting, or
            fraud-prevention purposes.
          </p>
          <p>
            On-chain transactions cannot be deleted or modified due to the
            immutable nature of the Solana blockchain.
          </p>
        </Section>

        <Section title="6. Security">
          <p>
            We use industry-standard practices to protect your data:
            encryption in transit (TLS), encryption at rest for sensitive
            tokens (AES-256-GCM), JWT-based session authentication, scoped
            OAuth grants, and least-privilege access controls. No system is
            perfectly secure, and we cannot guarantee absolute security.
          </p>
        </Section>

        <Section title="7. Your rights">
          <p>
            Depending on your jurisdiction (including the EU/EEA, UK,
            California, and other regions) you may have the right to:
          </p>
          <ul className="list-disc pl-6 space-y-2">
            <li>Access the personal data we hold about you.</li>
            <li>Request correction of inaccurate data.</li>
            <li>Request deletion of your data.</li>
            <li>Object to or restrict certain processing.</li>
            <li>Request a portable copy of your data.</li>
            <li>Withdraw consent for optional processing at any time.</li>
          </ul>
          <p className="mt-4">
            To exercise any of these rights, email us at the address in the
            Contact section below.
          </p>
        </Section>

        <Section title="8. Children">
          <p>
            Trading, wallet, payment, and digital-asset features are not
            directed to anyone under 18 or under the age of legal majority in
            their jurisdiction. We do not knowingly allow minors to use those
            features. If you believe a minor has provided us with personal
            information, please contact us and we will delete it as required.
          </p>
        </Section>

        <Section title="9. International transfers">
          <p>
            Ghola is operated from the United States and our processors may
            store data in the United States, the European Union, and other
            jurisdictions. By using the Services, you consent to the transfer
            of your information to these jurisdictions.
          </p>
        </Section>

        <Section title="10. Changes to this policy">
          <p>
            We may update this Privacy Policy from time to time. We will post
            the updated policy on this page with a new effective date. For
            material changes we will provide additional notice (such as an
            in-app banner or email).
          </p>
        </Section>

        <Section title="11. Contact">
          <p>
            For privacy questions or to exercise your rights, contact us at{" "}
            <a
              href="mailto:privacy@ghola.xyz"
              className="text-[#3da8ff] hover:underline"
            >
              privacy@ghola.xyz
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
