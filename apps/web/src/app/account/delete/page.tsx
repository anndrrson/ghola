import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Delete your Ghola account",
  description: "Delete a Ghola account and understand what data is removed or retained.",
};

const deletionMailto =
  "mailto:privacy@ghola.xyz?subject=Ghola%20account%20deletion%20request";

export default function DeleteGholaAccountPage() {
  return (
    <main className="min-h-screen bg-[#08090d] px-4 pb-20 pt-28 text-[#eef1f8] sm:px-6">
      <article className="mx-auto max-w-2xl">
        <p className="text-sm font-medium text-[#8793aa]">Account privacy</p>
        <h1 className="mt-3 text-4xl font-medium tracking-tight sm:text-5xl">
          Delete your Ghola account
        </h1>
        <p className="mt-5 max-w-xl text-base leading-7 text-[#aeb8ca]">
          You can delete directly in the Android app. Open Account, expand
          Advanced account details, choose Delete Ghola account, then type
          DELETE. Access is revoked immediately.
        </p>

        <section className="mt-10 rounded-2xl border border-[#202838] bg-[#0d1017] p-6">
          <h2 className="text-lg font-medium">Cannot access the app?</h2>
          <p className="mt-3 leading-7 text-[#aeb8ca]">
            Send a deletion request from an email or wallet identity you can
            verify. We complete verified requests within 30 days.
          </p>
          <a
            href={deletionMailto}
            className="mt-6 inline-flex min-h-12 items-center justify-center rounded-xl bg-[#eef1f8] px-5 font-medium text-[#08090d] transition hover:bg-white focus:outline-none focus:ring-2 focus:ring-[#8aa4ff]"
          >
            Request account deletion
          </a>
        </section>

        <section className="mt-10 space-y-5 text-[#aeb8ca]">
          <div>
            <h2 className="text-lg font-medium text-[#eef1f8]">What is removed</h2>
            <p className="mt-2 leading-7">
              Your Ghola profile, login identifiers, active sessions, API
              keys, connected-service tokens, private messages, task content,
              and on-device personalization are deleted or irreversibly
              anonymized.
            </p>
          </div>
          <div>
            <h2 className="text-lg font-medium text-[#eef1f8]">Limited retention</h2>
            <p className="mt-2 leading-7">
              Payment, settlement, security, and fraud-prevention records may
              be retained where required, without your account identity.
              Public blockchain transactions cannot be changed or erased.
            </p>
          </div>
          <div>
            <h2 className="text-lg font-medium text-[#eef1f8]">Subscriptions</h2>
            <p className="mt-2 leading-7">
              Deleting Ghola does not cancel a subscription owned by Google
              Play or another billing provider. Cancel it in that provider’s
              subscription manager to prevent future charges.
            </p>
          </div>
        </section>

        <p className="mt-10 text-sm text-[#8793aa]">
          See the complete <Link className="underline" href="/privacy">Privacy Policy</Link>.
        </p>
      </article>
    </main>
  );
}
