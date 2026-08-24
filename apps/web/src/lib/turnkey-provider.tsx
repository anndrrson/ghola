"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import {
  browserWalletFromSecret,
  createBrowserEd25519Wallet,
  isBrowserEd25519SecretKeyHex,
  signBrowserEd25519Bytes,
} from "./browser-ed25519-wallet";
import { sha256 } from "@noble/hashes/sha256";

const SCOPED_WALLET_STORAGE_PREFIX = "ghola_scoped_signing_wallet_v1";
const LEGACY_WALLET_QUARANTINE_KEY = "ghola_legacy_signing_wallet_quarantine_v1";
const LEGACY_WALLET_KEYS = [
  "turnkey_wallet_address",
  "turnkey_sub_org_id",
  "turnkey_wallet_id",
  "ghola_browser_ed25519_secret_key",
  "ghola_browser_wallet_address",
  "ghola_browser_sub_org_id",
  "ghola_browser_wallet_id",
] as const;

type WalletMode = "turnkey_server" | "browser_ed25519";

type ScopedWalletRecord = {
  version: 1;
  walletAddress: string;
  subOrgId: string;
  walletId: string;
  walletMode: WalletMode;
  browserSecretKeyHex: string | null;
};

interface TurnkeyWalletContext {
  walletAddress: string | null;
  subOrgId: string | null;
  walletId: string | null;
  walletMode: WalletMode | null;
  loading: boolean;
  createWallet: (email: string) => Promise<string>;
  signMessage: (message: string) => Promise<string>;
  /**
   * Sign arbitrary bytes (not necessarily valid UTF-8) with the
   * wallet's Ed25519 key. Used by the session-vault unlock challenge
   * which contains a binary salt. Returns 64 raw signature bytes.
   */
  signBytes: (bytes: Uint8Array) => Promise<Uint8Array>;
  clearWallet: () => void;
}

const TurnkeyContext = createContext<TurnkeyWalletContext>({
  walletAddress: null,
  subOrgId: null,
  walletId: null,
  walletMode: null,
  loading: true,
  createWallet: async () => "",
  signMessage: async () => "",
  signBytes: async () => new Uint8Array(),
  clearWallet: () => {},
});

export function TurnkeyWalletProvider({
  authEmail,
  authResolved,
  authScope,
  children,
}: {
  authEmail: string | null;
  authResolved: boolean;
  authScope: string | null;
  children: ReactNode;
}) {
  const [loaded, setLoaded] = useState<{
    authScope: string | null;
    record: ScopedWalletRecord | null;
    loading: boolean;
  }>({ authScope: null, record: null, loading: true });
  const activeScopeRef = useRef(authScope);

  const scopeLoaded = loaded.authScope === authScope;
  const activeRecord = scopeLoaded ? loaded.record : null;
  const walletAddress = activeRecord?.walletAddress ?? null;
  const subOrgId = activeRecord?.subOrgId ?? null;
  const walletId = activeRecord?.walletId ?? null;
  const walletMode = activeRecord?.walletMode ?? null;
  const browserSecretKeyHex = activeRecord?.browserSecretKeyHex ?? null;
  const loading = !scopeLoaded || loaded.loading;

  // An auth transition immediately hides the previous signer at render time.
  // The effect then loads only the newly authenticated user's namespace.
  useEffect(() => {
    if (!authResolved) {
      activeScopeRef.current = null;
      setLoaded({ authScope: null, record: null, loading: true });
      return;
    }
    activeScopeRef.current = authScope;
    const existing = authScope ? readScopedWalletRecord(localStorage, authScope) : null;
    const migrated = authScope && authEmail
      ? migrateOrQuarantineLegacyWallet(localStorage, authScope, authEmail, Boolean(existing))
      : null;
    setLoaded({
      authScope,
      record: existing || migrated,
      loading: false,
    });
  }, [authEmail, authResolved, authScope]);

  const setBrowserWallet = useCallback((scope: string, email?: string) => {
    const wallet = createBrowserEd25519Wallet(browserWalletLabel(email));
    const record: ScopedWalletRecord = {
      version: 1,
      walletAddress: wallet.walletAddress,
      subOrgId: wallet.subOrgId,
      walletId: wallet.walletId,
      walletMode: "browser_ed25519",
      browserSecretKeyHex: wallet.secretKeyHex,
    };
    writeScopedWalletRecord(localStorage, scope, record);
    if (activeScopeRef.current === scope) {
      setLoaded({ authScope: scope, record, loading: false });
    }
    return record.walletAddress;
  }, []);

  const createWallet = useCallback(async (email: string) => {
    const scope = authScope;
    if (!scope) throw new Error("Authenticated wallet scope is unavailable");
    try {
      const res = await fetch("/api/turnkey/create-wallet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Wallet creation failed" }));
        if (body?.code === "turnkey_server_controlled_wallets_disabled") {
          return setBrowserWallet(scope, email);
        }
        throw new Error(body.error || "Wallet creation failed");
      }
      const data = await res.json();
      const record: ScopedWalletRecord = {
        version: 1,
        walletAddress: data.walletAddress,
        subOrgId: data.subOrgId,
        walletId: data.walletId,
        walletMode: "turnkey_server",
        browserSecretKeyHex: null,
      };
      writeScopedWalletRecord(localStorage, scope, record);
      if (activeScopeRef.current === scope) {
        setLoaded({ authScope: scope, record, loading: false });
      }
      return record.walletAddress;
    } catch (error) {
      if (error instanceof TypeError) {
        return setBrowserWallet(scope, email);
      }
      throw error;
    }
  }, [authScope, setBrowserWallet]);

  const signMessage = useCallback(
    async (message: string): Promise<string> => {
      if (browserSecretKeyHex) {
        return bytesToBase64(
          signBrowserEd25519Bytes(browserSecretKeyHex, new TextEncoder().encode(message)),
        );
      }
      if (!subOrgId || !walletAddress) {
        throw new Error("No wallet available for signing");
      }
      const res = await fetch("/api/turnkey/sign-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, subOrgId, walletAddress }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Signing failed" }));
        throw new Error(body.error || "Signing failed");
      }
      const data = await res.json();
      return data.signature; // base64-encoded Ed25519 signature
    },
    [browserSecretKeyHex, subOrgId, walletAddress]
  );

  const signBytes = useCallback(
    async (bytes: Uint8Array): Promise<Uint8Array> => {
      if (browserSecretKeyHex) {
        return signBrowserEd25519Bytes(browserSecretKeyHex, bytes);
      }
      if (!subOrgId || !walletAddress) {
        throw new Error("No wallet available for signing");
      }
      // Encode bytes as hex for the Turnkey route's binary path. We do
      // NOT round-trip through TextDecoder/UTF-8 because the input
      // contains arbitrary cryptographic salt bytes.
      const hex = Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const res = await fetch("/api/turnkey/sign-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageHex: hex, subOrgId, walletAddress }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Signing failed" }));
        throw new Error(body.error || "Signing failed");
      }
      const data = await res.json();
      // The route returns a base64 64-byte Ed25519 signature.
      const bin = atob(data.signature);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      if (out.length !== 64) {
        throw new Error(`Turnkey returned ${out.length}-byte signature, expected 64`);
      }
      return out;
    },
    [browserSecretKeyHex, subOrgId, walletAddress]
  );

  const clearWallet = useCallback(() => {
    if (!authScope) return;
    localStorage.removeItem(scopedWalletStorageKey(authScope));
    if (activeScopeRef.current === authScope) {
      setLoaded({ authScope, record: null, loading: false });
    }
  }, [authScope]);

  return (
    <TurnkeyContext.Provider
      value={{
        walletAddress,
        subOrgId,
        walletId,
        walletMode,
        loading,
        createWallet,
        signMessage,
        signBytes,
        clearWallet,
      }}
    >
      {children}
    </TurnkeyContext.Provider>
  );
}

export function useTurnkeyWallet() {
  return useContext(TurnkeyContext);
}

export function opaqueTurnkeyWalletScope(userId: string): string | null {
  const normalized = userId.trim();
  if (!normalized) return null;
  const material = new TextEncoder().encode(`ghola-turnkey-wallet-scope-v1\0${normalized}`);
  return bytesToHex(sha256(material));
}

export function normalizeTurnkeyAuthEmail(email: string): string | null {
  const normalized = email.trim().toLowerCase();
  return normalized && normalized.includes("@") ? normalized : null;
}

function scopedWalletStorageKey(authScope: string) {
  return `${SCOPED_WALLET_STORAGE_PREFIX}:${authScope}`;
}

function readScopedWalletRecord(storage: Storage, authScope: string): ScopedWalletRecord | null {
  const raw = storage.getItem(scopedWalletStorageKey(authScope));
  if (!raw) return null;
  try {
    const candidate = JSON.parse(raw) as Partial<ScopedWalletRecord>;
    if (
      candidate.version !== 1 ||
      typeof candidate.walletAddress !== "string" || !candidate.walletAddress ||
      typeof candidate.subOrgId !== "string" || !candidate.subOrgId ||
      typeof candidate.walletId !== "string" || !candidate.walletId ||
      (candidate.walletMode !== "turnkey_server" && candidate.walletMode !== "browser_ed25519")
    ) return null;
    if (candidate.walletMode === "browser_ed25519") {
      if (!isBrowserEd25519SecretKeyHex(candidate.browserSecretKeyHex)) return null;
      const wallet = browserWalletFromSecret(hexToBytes(candidate.browserSecretKeyHex));
      if (wallet.walletAddress !== candidate.walletAddress) return null;
      return candidate as ScopedWalletRecord;
    }
    if (candidate.browserSecretKeyHex !== null) return null;
    return candidate as ScopedWalletRecord;
  } catch {
    return null;
  }
}

function writeScopedWalletRecord(storage: Storage, authScope: string, record: ScopedWalletRecord) {
  storage.setItem(scopedWalletStorageKey(authScope), JSON.stringify(record));
}

function migrateOrQuarantineLegacyWallet(
  storage: Storage,
  authScope: string,
  authEmail: string,
  scopedRecordExists: boolean,
): ScopedWalletRecord | null {
  const fields = legacyWalletFields(storage);
  sanitizeLegacyQuarantine(storage);
  if (fields.length === 0) return null;

  let migrated: ScopedWalletRecord | null = null;
  if (!scopedRecordExists) {
    const secret = storage.getItem("ghola_browser_ed25519_secret_key");
    const address = storage.getItem("ghola_browser_wallet_address");
    const subOrgId = storage.getItem("ghola_browser_sub_org_id");
    const walletId = storage.getItem("ghola_browser_wallet_id");
    if (isBrowserEd25519SecretKeyHex(secret) && address && subOrgId && walletId) {
      const derived = browserWalletFromSecret(hexToBytes(secret), browserWalletLabel(authEmail));
      if (
        derived.walletAddress === address &&
        derived.subOrgId === subOrgId &&
        derived.walletId === walletId
      ) {
        migrated = {
          version: 1,
          walletAddress: derived.walletAddress,
          subOrgId: derived.subOrgId,
          walletId: derived.walletId,
          walletMode: "browser_ed25519",
          browserSecretKeyHex: secret,
        };
        writeScopedWalletRecord(storage, authScope, migrated);
      }
    }
  }

  storage.setItem(LEGACY_WALLET_QUARANTINE_KEY, JSON.stringify({
    version: 2,
    fields,
    resolution: migrated
      ? "migrated_matching_browser_identity"
      : scopedRecordExists
        ? "discarded_existing_scoped_identity"
        : "discarded_unverified_identity",
  }));
  for (const key of LEGACY_WALLET_KEYS) storage.removeItem(key);
  return migrated;
}

function legacyWalletFields(storage: Storage) {
  return LEGACY_WALLET_KEYS.filter((key) => storage.getItem(key) !== null);
}

function sanitizeLegacyQuarantine(storage: Storage) {
  const raw = storage.getItem(LEGACY_WALLET_QUARANTINE_KEY);
  if (!raw) return;
  try {
    const candidate = JSON.parse(raw) as { fields?: unknown; legacy?: unknown };
    const fields = Array.isArray(candidate.fields)
      ? candidate.fields.filter((field): field is string => typeof field === "string")
      : candidate.legacy && typeof candidate.legacy === "object"
        ? Object.keys(candidate.legacy)
        : [];
    storage.setItem(LEGACY_WALLET_QUARANTINE_KEY, JSON.stringify({
      version: 2,
      fields,
      resolution: "discarded_unverified_identity",
    }));
  } catch {
    storage.removeItem(LEGACY_WALLET_QUARANTINE_KEY);
  }
}

function browserWalletLabel(email?: string | null) {
  const normalized = normalizeTurnkeyAuthEmail(email || "");
  return normalized
    ? `ghola-${normalized.replace(/[^a-z0-9]+/g, "-").slice(0, 48)}`
    : "ghola-browser";
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
