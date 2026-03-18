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
        <h1 className="text-2xl font-bold text-[#eef1f8]">Export Identity</h1>
        <p className="mt-1 text-[#8b95a8]">
          Back up your vault, export your recovery phrase, or run fully
          local.
        </p>
      </div>

      {/* Section 1: Download Encrypted Wallet */}
      <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="rounded-lg bg-[#3da8ff]/10 p-2 text-[#3da8ff]">
            <Download className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-[#eef1f8]">
              Download Encrypted Backup
            </h2>
            <p className="text-sm text-[#8b95a8]">
              Your vault is encrypted with your password and stored securely.
            </p>
          </div>
        </div>

        <p className="text-xs text-[#4a5568] mb-4">
          This backup file contains your encrypted vault. You will need your
          account password to decrypt it. Store it somewhere safe.
        </p>

        {downloadError && (
          <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
            {downloadError}
          </div>
        )}

        <button
          onClick={handleDownloadWallet}
          disabled={downloading}
          className="inline-flex items-center gap-2 rounded-lg bg-[#3da8ff] px-5 py-2.5 text-sm font-semibold text-[#eef1f8] hover:bg-[#5bb8ff] disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
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
      <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="rounded-lg bg-amber-500/10 p-2 text-amber-400">
            <Key className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-[#eef1f8]">
              Export Recovery Phrase
            </h2>
            <p className="text-sm text-[#8b95a8]">
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
                className="block text-sm font-medium text-[#8b95a8] mb-1.5"
              >
                Enter your password to continue
              </label>
              <input
                id="mnemonic-password"
                type="password"
                value={mnemonicPassword}
                onChange={(e) => setMnemonicPassword(e.target.value)}
                placeholder="Account password"
                className="w-full rounded-lg border border-[#1e2a3a] bg-[#0f1117] px-4 py-2.5 text-sm text-[#eef1f8] placeholder-[#4a5568] focus:border-[#3da8ff] focus:ring-1 focus:ring-[#3da8ff] outline-none transition-colors"
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
          <div className="rounded-lg border border-[#1e2a3a] bg-[#161822] px-4 py-4">
            <div className="flex items-start gap-2 mb-3">
              <Lock className="h-4 w-4 text-[#3da8ff] mt-0.5 shrink-0" />
              <p className="text-sm text-[#8b95a8] font-medium">
                Client-side mnemonic export
              </p>
            </div>
            <p className="text-sm text-[#8b95a8]">
              Client-side mnemonic export requires the WASM wallet module. This
              feature will be enabled when you create your wallet via the
              browser. In the meantime, you can export your recovery phrase
              using the ghola CLI:
            </p>
            <div className="mt-3 rounded-lg bg-[#0f1117] px-4 py-3 font-mono text-sm text-[#8b95a8]">
              said export --mnemonic
            </div>
            <button
              onClick={() => {
                setMnemonicRevealed(false);
                setMnemonicPassword("");
              }}
              className="mt-4 text-sm text-[#4a5568] hover:text-[#8b95a8] transition-colors cursor-pointer"
            >
              Close
            </button>
          </div>
        )}
      </div>

      {/* Section 3: Go Self-Custody */}
      <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="rounded-lg bg-[#3da8ff]/10 p-2 text-[#3da8ff]">
            <Terminal className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-[#eef1f8]">
              Go Local
            </h2>
            <p className="text-sm text-[#8b95a8]">
              Export your identity to use with the ghola CLI for full
              local control.
            </p>
          </div>
        </div>

        <div className="space-y-4">
          <p className="text-sm text-[#8b95a8]">
            The ghola CLI lets you run your own identity server and connect
            to AI services without relying on this web dashboard. Your keys
            never leave your machine.
          </p>

          <div className="rounded-lg border border-[#1e2a3a] bg-[#161822] p-4 space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-[#4a5568]">
              Getting started
            </p>
            <div className="space-y-2">
              <div className="rounded-lg bg-[#0f1117] px-4 py-2.5 font-mono text-sm text-[#8b95a8]">
                cargo install said
              </div>
              <div className="rounded-lg bg-[#0f1117] px-4 py-2.5 font-mono text-sm text-[#8b95a8]">
                said recover
              </div>
              <p className="text-xs text-[#4a5568]">
                Use your recovery phrase or import your encrypted backup
                to initialize the CLI.
              </p>
              <div className="rounded-lg bg-[#0f1117] px-4 py-2.5 font-mono text-sm text-[#8b95a8]">
                said daemon start
              </div>
              <p className="text-xs text-[#4a5568]">
                Start the background daemon to serve your identity to AI
                services via MCP.
              </p>
            </div>
          </div>

          <a
            href="https://github.com/anndrrson/said"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 text-sm font-medium text-[#3da8ff] hover:text-[#5bb8ff] transition-colors"
          >
            View documentation
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      </div>
    </div>
  );
}
