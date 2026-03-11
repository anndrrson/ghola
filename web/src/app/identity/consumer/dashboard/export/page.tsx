"use client";

import { useState } from "react";
import { downloadWallet } from "@/lib/api";
import {
  Download,
  Key,
  Terminal,
  AlertTriangle,
  Loader2,
  Lock,
  ExternalLink,
} from "lucide-react";

export default function ConsumerExportPage() {
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState("");

  const [mnemonicPassword, setMnemonicPassword] = useState("");
  const [mnemonicRevealed, setMnemonicRevealed] = useState(false);

  async function handleDownloadWallet() {
    setDownloadError("");
    setDownloading(true);
    try {
      const result = await downloadWallet();
      if (!result) {
        setDownloadError(
          "No wallet backup found. Create your wallet first to enable backups."
        );
        return;
      }
      // Create downloadable JSON file
      const blob = new Blob(
        [JSON.stringify({ encrypted_wallet: result.encrypted_wallet }, null, 2)],
        { type: "application/json" }
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "said-wallet-backup.json";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setDownloadError(
        err instanceof Error ? err.message : "Failed to download wallet."
      );
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white">Export Identity</h1>
        <p className="mt-1 text-gray-400">
          Back up your wallet, export your recovery phrase, or go fully
          self-custody.
        </p>
      </div>

      {/* Section 1: Download Encrypted Wallet */}
      <div className="rounded-xl border border-gray-800 bg-gray-900/60 p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="rounded-lg bg-said-500/10 p-2 text-said-400">
            <Download className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-white">
              Download Encrypted Wallet
            </h2>
            <p className="text-sm text-gray-400">
              Your wallet is encrypted with your password and stored securely.
            </p>
          </div>
        </div>

        <p className="text-xs text-gray-500 mb-4">
          This backup file contains your encrypted wallet. You will need your
          account password to decrypt it. Store it somewhere safe as a backup.
        </p>

        {downloadError && (
          <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
            {downloadError}
          </div>
        )}

        <button
          onClick={handleDownloadWallet}
          disabled={downloading}
          className="inline-flex items-center gap-2 rounded-lg bg-said-500 px-5 py-2.5 text-sm font-semibold text-white hover:bg-said-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
        >
          {downloading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Download className="h-4 w-4" />
          )}
          {downloading ? "Downloading..." : "Download Backup"}
        </button>
      </div>

      {/* Section 2: Export Mnemonic */}
      <div className="rounded-xl border border-gray-800 bg-gray-900/60 p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="rounded-lg bg-amber-500/10 p-2 text-amber-400">
            <Key className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-white">
              Export Recovery Phrase
            </h2>
            <p className="text-sm text-gray-400">
              For advanced users who want direct access to their mnemonic.
            </p>
          </div>
        </div>

        {/* Warning */}
        <div className="mb-5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-400 mt-0.5 shrink-0" />
            <p className="text-sm text-amber-300">
              Your recovery phrase gives full access to your identity. Never
              share it with anyone, and never enter it on websites you do not
              trust.
            </p>
          </div>
        </div>

        {!mnemonicRevealed ? (
          <div className="space-y-4">
            <div>
              <label
                htmlFor="mnemonic-password"
                className="block text-sm font-medium text-gray-300 mb-1.5"
              >
                Enter your password to continue
              </label>
              <input
                id="mnemonic-password"
                type="password"
                value={mnemonicPassword}
                onChange={(e) => setMnemonicPassword(e.target.value)}
                placeholder="Account password"
                className="w-full rounded-lg border border-gray-700 bg-gray-900 px-4 py-2.5 text-sm text-white placeholder-gray-500 focus:border-said-500 focus:ring-1 focus:ring-said-500 outline-none transition-colors"
              />
            </div>
            <button
              onClick={() => setMnemonicRevealed(true)}
              disabled={!mnemonicPassword}
              className="inline-flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-5 py-2.5 text-sm font-semibold text-amber-300 hover:bg-amber-500/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
            >
              <Lock className="h-4 w-4" />
              Reveal Recovery Phrase
            </button>
          </div>
        ) : (
          <div className="rounded-lg border border-gray-700 bg-gray-800 px-4 py-4">
            <div className="flex items-start gap-2 mb-3">
              <Lock className="h-4 w-4 text-said-400 mt-0.5 shrink-0" />
              <p className="text-sm text-gray-300 font-medium">
                Client-side mnemonic export
              </p>
            </div>
            <p className="text-sm text-gray-400">
              Client-side mnemonic export requires the WASM wallet module. This
              feature will be enabled when you create your wallet via the
              browser. In the meantime, you can export your recovery phrase
              using the SAID CLI:
            </p>
            <div className="mt-3 rounded-lg bg-gray-900 px-4 py-3 font-mono text-sm text-gray-300">
              said export --mnemonic
            </div>
            <button
              onClick={() => {
                setMnemonicRevealed(false);
                setMnemonicPassword("");
              }}
              className="mt-4 text-sm text-gray-500 hover:text-gray-300 transition-colors cursor-pointer"
            >
              Close
            </button>
          </div>
        )}
      </div>

      {/* Section 3: Go Self-Custody */}
      <div className="rounded-xl border border-gray-800 bg-gray-900/60 p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="rounded-lg bg-said-500/10 p-2 text-said-400">
            <Terminal className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-white">
              Go Self-Custody
            </h2>
            <p className="text-sm text-gray-400">
              Export your identity to use with the SAID CLI for full
              self-custody.
            </p>
          </div>
        </div>

        <div className="space-y-4">
          <p className="text-sm text-gray-400">
            The SAID CLI lets you run your own identity daemon, manage UCAN
            tokens, and connect to AI services without relying on this web
            dashboard. Your keys never leave your machine.
          </p>

          <div className="rounded-lg border border-gray-700 bg-gray-800 p-4 space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">
              Getting started
            </p>
            <div className="space-y-2">
              <div className="rounded-lg bg-gray-900 px-4 py-2.5 font-mono text-sm text-gray-300">
                cargo install said-cli
              </div>
              <div className="rounded-lg bg-gray-900 px-4 py-2.5 font-mono text-sm text-gray-300">
                said recover
              </div>
              <p className="text-xs text-gray-500">
                Use your recovery phrase or import your encrypted wallet backup
                to initialize the CLI.
              </p>
              <div className="rounded-lg bg-gray-900 px-4 py-2.5 font-mono text-sm text-gray-300">
                said daemon start
              </div>
              <p className="text-xs text-gray-500">
                Start the background daemon to serve your identity to AI
                services via MCP.
              </p>
            </div>
          </div>

          <a
            href="https://github.com/anndrrson/said"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 text-sm font-medium text-said-400 hover:text-said-300 transition-colors"
          >
            View documentation
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      </div>
    </div>
  );
}
