import Link from "next/link";
import { GholaLogo } from "@/components/GholaLogo";

export function Footer() {
  return (
    <footer className="border-t border-[#1e2a3a] bg-[#08090d]">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid gap-8 sm:grid-cols-4">
          <div>
            <div className="flex items-center gap-2">
              <GholaLogo size={24} className="text-[#eef1f8]" />
              <span className="text-lg font-bold text-[#eef1f8]">
                ghola
              </span>
            </div>
            <p className="mt-2 text-sm text-[#4a5568]">
              AI agent identity & vault.
            </p>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-[#8b95a8] mb-3">Identity</h3>
            <div className="space-y-2">
              <Link href="/identity/dashboard" className="block text-sm text-[#4a5568] hover:text-[#8b95a8] transition-colors">
                Dashboard
              </Link>
              <Link href="/identity/register" className="block text-sm text-[#4a5568] hover:text-[#8b95a8] transition-colors">
                Get Started
              </Link>
            </div>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-[#8b95a8] mb-3">Models</h3>
            <div className="space-y-2">
              <Link href="/models" className="block text-sm text-[#4a5568] hover:text-[#8b95a8] transition-colors">
                Browse
              </Link>
              <Link href="/models/creator" className="block text-sm text-[#4a5568] hover:text-[#8b95a8] transition-colors">
                Create
              </Link>
              <Link href="/models/account" className="block text-sm text-[#4a5568] hover:text-[#8b95a8] transition-colors">
                Account
              </Link>
            </div>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-[#8b95a8] mb-3">Resources</h3>
            <div className="space-y-2">
              <a
                href="https://github.com/anndrrson/said"
                target="_blank"
                rel="noopener noreferrer"
                className="block text-sm text-[#4a5568] hover:text-[#8b95a8] transition-colors"
              >
                GitHub
              </a>
            </div>
          </div>
        </div>
        <div className="mt-8 border-t border-[#1e2a3a] pt-8 text-center text-xs text-[#4a5568]">
          &copy; {new Date().getFullYear()} Ghola. All rights reserved.
        </div>
      </div>
    </footer>
  );
}
