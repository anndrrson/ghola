/**
 * Read-only client for the on-chain model registry on Solana.
 *
 * Tier 1A's a16z-coded claim: anonymous users *read* the protocol even
 * before they sign in. The verified-hash badge in the chat header is
 * the visible artifact — a cold visitor watching an in-browser model
 * load sees the client check the chain for that model's published
 * metadata before any inference happens.
 *
 * The on-chain program does not exist yet (a Tier 1A.5 deliverable).
 * Until it does, `lookupModel` returns `{ status: "unregistered" }` and
 * the chat header surfaces "Registry pending" rather than blocking the
 * flow. When the program ships, only the program id and account schema
 * below need to change — call sites keep working.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha256";

// Program id of the on-chain model registry. The real program id is
// `MdLRegMa1iYxBg5gKhCJVTDfXkqHpQF6PoG3kRYW6S1` (reserved in
// Anchor.toml) but the program is not deployed yet, so the client
// defaults to the System Program as a known-valid placeholder that
// produces deterministic off-curve PDAs for the test + dev flow.
// Override via env when running against devnet / mainnet.
const REGISTRY_PROGRAM_ID = new PublicKey(
  (typeof process !== "undefined" &&
    process.env?.NEXT_PUBLIC_MODEL_REGISTRY_PROGRAM_ID) ||
    "11111111111111111111111111111111",
);

const PDA_SEED_PREFIX = "ghola-model";

// Mainnet by default; override via env so dev/preview can point at
// devnet without rebuilding. Public RPC is fine for read-only — no
// signing, no rate-sensitive writes.
function rpcUrl(): string {
  if (typeof process !== "undefined" && process.env) {
    const explicit = process.env.NEXT_PUBLIC_SOLANA_RPC_URL;
    if (explicit) return explicit;
  }
  return "https://api.mainnet-beta.solana.com";
}

let connection: Connection | null = null;
function getConnection(): Connection {
  if (!connection) {
    connection = new Connection(rpcUrl(), "confirmed");
  }
  return connection;
}

export type ModelRegistryStatus =
  | "verified"
  | "mismatch"
  | "unregistered"
  | "unreachable";

export interface ModelRegistryResult {
  status: ModelRegistryStatus;
  modelId: string;
  /** Hex-encoded SHA-256 of the model weights, when on-chain. */
  onChainHash?: string;
  /** Creator DID, when on-chain. */
  creatorDid?: string;
  /** IPFS CID for the weights, when on-chain. */
  ipfsCid?: string;
  /** Solana slot the registry entry was read at. */
  slot?: number;
  /** Set on unreachable; human-readable. */
  error?: string;
}

/**
 * Derive the canonical PDA for a model id under the registry program.
 * Returned even when the program isn't deployed — the address is
 * deterministic, so the client can pre-render "verified at $addr"
 * before the chain confirms.
 */
export async function deriveModelPda(modelId: string): Promise<PublicKey> {
  // Solana PDA seeds cap at 32 bytes each. Model ids can exceed that
  // (e.g. "Llama-3.2-1B-Instruct-q4f16_1-MLC" is 33 bytes), so the
  // canonical seed is sha256(model_id). Anchor program mirrors this
  // derivation in programs/ghola-model-registry.
  //
  // The seeds are wrapped in Buffer because @solana/web3.js performs
  // strict-equality checks against the Buffer prototype in some code
  // paths; bare Uint8Array works at runtime in Node but fails in jsdom
  // where the cross-realm prototype mismatch defeats the check.
  const idHash = sha256(new TextEncoder().encode(modelId));
  const [pda] = await PublicKey.findProgramAddress(
    [Buffer.from(PDA_SEED_PREFIX, "utf8"), Buffer.from(idHash)],
    REGISTRY_PROGRAM_ID,
  );
  return pda;
}

/**
 * Look up a model's on-chain registry record. Read-only; no wallet,
 * no signature, anonymous-safe.
 *
 * The current return path for any real `modelId` will be
 * `"unregistered"` until the Solana program lands — the call is
 * structured so the visible artifact (the badge) exercises the read
 * path against a real RPC, demonstrating that the protocol *would*
 * have answered if a record existed.
 */
export async function lookupModel(
  modelId: string,
): Promise<ModelRegistryResult> {
  try {
    const pda = await deriveModelPda(modelId);
    const conn = getConnection();
    const info = await conn.getAccountInfo(pda, "confirmed");
    if (!info) {
      return { status: "unregistered", modelId };
    }
    // Once the program ships, decode info.data here against the
    // registry account schema (Anchor IDL) and return verified /
    // mismatch based on the on-chain hash. Until then, the presence
    // of any account at the deterministic PDA is treated as a stub
    // hit — surface it as unregistered + the slot so the operator
    // can see the read fired.
    const slot = await conn.getSlot("confirmed");
    return { status: "unregistered", modelId, slot };
  } catch (err) {
    return {
      status: "unreachable",
      modelId,
      error: err instanceof Error ? err.message : "rpc error",
    };
  }
}
