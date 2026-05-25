import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Service — Ghola",
  description:
    "The terms governing your use of the Ghola web application, mobile application, and APIs.",
};

const EFFECTIVE_DATE = "April 29, 2026";

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-[#08090d] pt-16">
      <article className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8 py-20 text-[#c9d1de]">
        <header className="mb-12">
          <h1 className="text-4xl md:text-5xl font-medium tracking-tight text-[#eef1f8] leading-[1.05]">
            Terms of Service
          </h1>
          <p className="mt-4 text-sm text-[#8b95a8]">
            Effective date: {EFFECTIVE_DATE}
          </p>
        </header>

        <Section title="1. Acceptance of terms">
          <p>
            These Terms of Service (&ldquo;Terms&rdquo;) form a binding
            agreement between you and Ghola (&ldquo;Ghola,&rdquo;
            &ldquo;we,&rdquo; &ldquo;us,&rdquo; or &ldquo;our&rdquo;) governing
            your use of the Ghola web application at ghola.xyz, the Ghola
            mobile application, the Ghola APIs, and all related services
            (collectively, the &ldquo;Services&rdquo;). By accessing or using
            the Services, you agree to be bound by these Terms and by our{" "}
            <a href="/privacy" className="text-[#3da8ff] hover:underline">
              Privacy Policy
            </a>
            . If you do not agree, do not use the Services.
          </p>
        </Section>

        <Section title="2. Eligibility">
          <p>
            You must be at least 13 years old (16 in the EEA) to use the
            Services. By using the Services, you represent that you meet this
            requirement, that you have the legal capacity to enter into this
            agreement, and that you are not prohibited from using the Services
            under the laws of your jurisdiction.
          </p>
        </Section>

        <Section title="3. Accounts">
          <p>
            Ghola accounts are wallet-first. You are responsible for keeping
            your wallet, device, private keys, seed phrases, recovery material,
            and wallet approval prompts secure. You are responsible for all
            activity authorised through your wallet session. You must promptly
            notify us of any unauthorised use. We may suspend or terminate
            accounts that violate these Terms.
          </p>
        </Section>

        <Section title="4. The Services">
          <p>
            Ghola provides AI-powered agents that can chat, place voice calls,
            send and receive emails, control connected applications, query AI
            models, and transact with USDC on the Solana blockchain on your
            behalf. The Services include identity tooling (SAID), a model
            marketplace, a compute marketplace, and a merchant registry.
          </p>
          <p>
            You acknowledge that AI outputs may be inaccurate, incomplete, or
            inappropriate, and that you should review outputs before relying
            on them. You are responsible for the tasks you assign to your
            agent and for the consequences of those tasks.
          </p>
        </Section>

        <Section title="5. Wallets and on-chain transactions">
          <p>
            The Services interact with self-custodial wallets, including the
            Solana Seeker Seed Vault. You retain sole control of your private
            keys and recovery material. You are solely responsible for
            safeguarding them. We cannot recover lost keys or reverse on-chain
            transactions.
          </p>
          <p>
            Blockchain transactions are final and irreversible. Network fees,
            congestion, and slippage are outside our control. You bear all
            risks associated with the use of cryptocurrencies, including
            volatility, regulatory uncertainty, smart-contract risk, and total
            loss.
          </p>
        </Section>

        <Section title="6. Voice calls and call-recording compliance">
          <p>
            When you ask Ghola to place a phone call on your behalf, you
            authorise us and our voice provider (Bland AI) to place that call
            using an automated voice. You are solely responsible for ensuring
            that the calls you initiate comply with all applicable laws,
            including telemarketing, robocall, do-not-call, and one-party or
            two-party consent recording laws (such as the U.S. TCPA and
            equivalent regulations in your jurisdiction). You will not use
            Ghola to harass, defraud, threaten, or impersonate another person.
          </p>
        </Section>

        <Section title="7. Connected accounts">
          <p>
            When you connect Gmail, Google Calendar, or other third-party
            services, you authorise Ghola to access those services on your
            behalf within the scopes you grant. You may revoke access at any
            time from your provider&apos;s security settings. Use of those
            services is governed by their own terms.
          </p>
        </Section>

        <Section title="8. Subscriptions, payments, and refunds">
          <p>
            Some features require a paid subscription. Subscription fees are
            billed in advance via Stripe and are non-refundable except where
            required by law. You may cancel at any time; cancellation takes
            effect at the end of the current billing period. Usage-based fees
            (per-call inference, voice call minutes, USDC settlement) are
            charged as incurred.
          </p>
          <p>
            On the marketplace, payments to creators and operators are settled
            in USDC on Solana. The creator or operator share is paid net of a
            platform fee disclosed in the relevant marketplace listing.
          </p>
        </Section>

        <Section title="9. User content and licence">
          <p>
            You retain ownership of any content you submit to the Services
            (including prompts, agent configurations, uploaded documents, and
            model fine-tunes you create). You grant Ghola a worldwide,
            royalty-free, non-exclusive licence to host, store, process, and
            display that content solely as needed to operate and improve the
            Services and to fulfil tasks you initiate.
          </p>
          <p>
            You represent that you have all necessary rights to the content
            you submit and that it does not infringe any third-party rights.
          </p>
        </Section>

        <Section title="10. Acceptable use">
          <p>You agree not to use the Services to:</p>
          <ul className="list-disc pl-6 space-y-2">
            <li>Violate any law or regulation.</li>
            <li>
              Infringe intellectual property, privacy, or publicity rights.
            </li>
            <li>
              Generate or distribute malware, phishing content, or spam.
            </li>
            <li>
              Place harassing, fraudulent, or non-consenting calls or
              messages.
            </li>
            <li>
              Generate sexual content involving minors, content that incites
              violence, or content that promotes terrorism.
            </li>
            <li>
              Attempt to circumvent rate limits, billing, or access controls.
            </li>
            <li>
              Reverse engineer, decompile, or disassemble the Services except
              where permitted by law.
            </li>
            <li>
              Use the Services to develop a competing product by training on
              outputs in violation of these Terms or applicable law.
            </li>
            <li>
              Interfere with or disrupt the Services or any user&apos;s
              experience.
            </li>
          </ul>
          <p className="mt-4">
            We may suspend or terminate your access for violations.
          </p>
        </Section>

        <Section title="11. Third-party services">
          <p>
            The Services integrate with third-party providers (including
            Anthropic, Together.ai, Bland AI, Google, Stripe, and Solana RPC
            providers). We are not responsible for the availability, accuracy,
            or content of third-party services, and your use of them is
            governed by their terms.
          </p>
        </Section>

        <Section title="12. Intellectual property">
          <p>
            The Services, including all software, design, trademarks, and
            content (other than user content), are owned by Ghola or its
            licensors and are protected by intellectual property laws. We
            grant you a limited, revocable, non-exclusive, non-transferable
            licence to use the Services in accordance with these Terms.
          </p>
        </Section>

        <Section title="13. Disclaimers">
          <p className="uppercase text-xs tracking-wide text-[#8b95a8]">
            Important
          </p>
          <p>
            THE SERVICES ARE PROVIDED &ldquo;AS IS&rdquo; AND &ldquo;AS
            AVAILABLE&rdquo; WITHOUT WARRANTIES OF ANY KIND, WHETHER EXPRESS
            OR IMPLIED, INCLUDING WARRANTIES OF MERCHANTABILITY, FITNESS FOR
            A PARTICULAR PURPOSE, NON-INFRINGEMENT, ACCURACY, OR
            UNINTERRUPTED OPERATION. WE DO NOT WARRANT THAT THE SERVICES WILL
            BE ERROR-FREE OR THAT AI OUTPUTS WILL BE ACCURATE, COMPLETE,
            CURRENT, OR APPROPRIATE FOR YOUR PURPOSE.
          </p>
        </Section>

        <Section title="14. Limitation of liability">
          <p>
            TO THE MAXIMUM EXTENT PERMITTED BY LAW, GHOLA SHALL NOT BE LIABLE
            FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE
            DAMAGES, OR ANY LOSS OF PROFITS, REVENUE, DATA, GOODWILL, OR
            CRYPTOCURRENCY, ARISING FROM OR RELATED TO YOUR USE OF THE
            SERVICES. OUR AGGREGATE LIABILITY FOR ANY CLAIM ARISING OUT OF OR
            RELATED TO THESE TERMS OR THE SERVICES SHALL NOT EXCEED THE
            GREATER OF (A) THE AMOUNTS YOU PAID TO US IN THE TWELVE MONTHS
            PRECEDING THE CLAIM, OR (B) ONE HUNDRED U.S. DOLLARS ($100).
          </p>
        </Section>

        <Section title="15. Indemnification">
          <p>
            You agree to indemnify and hold harmless Ghola, its officers,
            directors, employees, and agents from any claim, loss, or expense
            (including reasonable attorneys&apos; fees) arising from your use
            of the Services, your content, your violation of these Terms, or
            your violation of any third-party right or applicable law.
          </p>
        </Section>

        <Section title="16. Termination">
          <p>
            You may stop using the Services at any time and delete your
            account from in-app settings. We may suspend or terminate your
            access at any time for any reason, including violation of these
            Terms. Upon termination, the rights granted to you cease, but
            sections that by their nature should survive (including
            ownership, disclaimers, limitations, and indemnification) will
            survive.
          </p>
        </Section>

        <Section title="17. Governing law and disputes">
          <p>
            These Terms are governed by the laws of the State of Delaware,
            United States, without regard to conflict-of-laws principles.
            Disputes arising out of or related to these Terms shall be
            resolved exclusively in the state or federal courts located in
            Delaware, and you consent to personal jurisdiction there. Where
            permitted by law, you and Ghola waive any right to a jury trial
            and to participate in a class action.
          </p>
        </Section>

        <Section title="18. Changes to these terms">
          <p>
            We may revise these Terms from time to time. We will post the
            updated Terms on this page with a new effective date. Material
            changes will be communicated via in-app notice or email. Your
            continued use of the Services after the effective date constitutes
            acceptance of the revised Terms.
          </p>
        </Section>

        <Section title="19. Contact">
          <p>
            Questions about these Terms? Email{" "}
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
