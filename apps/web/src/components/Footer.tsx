import Link from "next/link";
import { GholaLogo } from "@/components/GholaLogo";

// Slim consumer-product footer. Deliberately doesn't surface the
// protocol surfaces (/agents, /models, /marketplace, /provide, etc.)
// — those exist by direct URL only for investors and journalists.
// Support / Privacy / Terms remain because they're required for the
// consumer app review path. /security stays unlinked from anywhere on
// the public site; if a reviewer needs it they get the URL directly.
export function Footer() {
  return (
    <footer className="border-t border-[#1e2a3a] bg-[#08090d]">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-10">
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-[#4a5568]">
          <div className="flex items-center gap-2">
            <GholaLogo size={20} className="text-[#8b95a8]" />
            <span className="font-medium text-[#8b95a8]">ghola</span>
            <span className="text-[#2a3a50]">·</span>
            <span>&copy; {new Date().getFullYear()}</span>
          </div>
          <div className="flex items-center gap-5">
            <Link
              href="/support"
              className="hover:text-[#8b95a8] transition-colors"
            >
              Support
            </Link>
            <Link
              href="/privacy"
              className="hover:text-[#8b95a8] transition-colors"
            >
              Privacy
            </Link>
            <Link
              href="/terms"
              className="hover:text-[#8b95a8] transition-colors"
            >
              Terms
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
