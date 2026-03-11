import Link from "next/link";

export function Footer() {
  return (
    <footer className="border-t border-gray-800 bg-gray-950">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid gap-8 sm:grid-cols-4">
          <div>
            <span className="text-lg font-bold text-white">
              kinakuta
            </span>
            <p className="mt-2 text-sm text-gray-500">
              The platform for the agentic web.
            </p>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-gray-300 mb-3">Identity</h3>
            <div className="space-y-2">
              <Link href="/identity/dashboard" className="block text-sm text-gray-500 hover:text-gray-300 transition-colors">
                Dashboard
              </Link>
              <Link href="/identity/register" className="block text-sm text-gray-500 hover:text-gray-300 transition-colors">
                Get Started
              </Link>
            </div>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-gray-300 mb-3">Models</h3>
            <div className="space-y-2">
              <Link href="/models" className="block text-sm text-gray-500 hover:text-gray-300 transition-colors">
                Browse
              </Link>
              <Link href="/models/creator" className="block text-sm text-gray-500 hover:text-gray-300 transition-colors">
                Create
              </Link>
              <Link href="/models/account" className="block text-sm text-gray-500 hover:text-gray-300 transition-colors">
                Account
              </Link>
            </div>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-gray-300 mb-3">Resources</h3>
            <div className="space-y-2">
              <a
                href="https://github.com/anndrrson/said"
                target="_blank"
                rel="noopener noreferrer"
                className="block text-sm text-gray-500 hover:text-gray-300 transition-colors"
              >
                GitHub
              </a>
            </div>
          </div>
        </div>
        <div className="mt-8 border-t border-gray-800 pt-8 text-center text-xs text-gray-600">
          &copy; {new Date().getFullYear()} Kinakuta. All rights reserved.
        </div>
      </div>
    </footer>
  );
}
