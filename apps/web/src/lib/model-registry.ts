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

// Program id of the on-chain model registry. Deployed live on Solana
// devnet at this address (matches `declare_id!` in
// programs/ghola-model-registry/src/lib.rs and the entry in
// Anchor.toml). Override via env when pointing at localnet / mainnet.
const REGISTRY_PROGRAM_ID = new PublicKey(
  (typeof process !== "undefined" &&
    process.env?.NEXT_PUBLIC_MODEL_REGISTRY_PROGRAM_ID) ||
    "7hZ9oxHyFRpKHtH3jsa8NeH4HYGrPT7ZttDFtUX9naNS",
);

const PDA_SEED_PREFIX = "ghola-model";

// Devnet by default — the registry program is currently deployed on
// devnet only. Override via NEXT_PUBLIC_SOLANA_RPC_URL when the
// program is promoted to mainnet. Public RPC is fine for read-only;
// no signing, no rate-sensitive writes happen on this path.
function rpcUrl(): string {
  if (typeof process !== "undefined" && process.env) {
    const explicit = process.env.NEXT_PUBLIC_SOLANA_RPC_URL;
    if (explicit) return explicit;
  }
  return "https://api.devnet.solana.com";
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
  /** Hex-encoded SHA-256 of the model weights manifest, when on-chain. */
  onChainHash?: string;
  /** Creator Solana pubkey (base58), when on-chain. */
  creator?: string;
  /** IPFS CID for the weights bundle, when on-chain. */
  ipfsCid?: string;
  /** SPDX license identifier, when on-chain. */
  licenseSpdx?: string;
  /** Per-call price in micro-USDC, when on-chain. */
  priceMicroUsdc?: number;
  /** Hex-encoded SHA-256 of the WASM model_lib, when on-chain. */
  modelLibHash?: string;
  /** Hex-encoded SHA-256 of the model config, when on-chain. */
  configHash?: string;
  /** Hex-encoded SHA-256 of the tokenizer, when on-chain. */
  tokenizerHash?: string;
  /** Monotonic version of the record; bumps on every update. */
  version?: number;
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
    const slot = await conn.getSlot("confirmed");
    try {
      const decoded = decodeModelRecord(info.data);
      // Sanity: the on-chain model_id must match what we queried for.
      // Mismatch means a hash collision (statistically impossible) or
      // a misconfigured registry entry — either way, refuse to trust.
      if (decoded.modelId !== modelId) {
        return {
          status: "mismatch",
          modelId,
          slot,
          error: `on-chain model_id "${decoded.modelId}" does not match queried "${modelId}"`,
        };
      }
      return {
        status: "verified",
        modelId,
        slot,
        creator: decoded.creator,
        onChainHash: decoded.weightsHash,
        modelLibHash: decoded.modelLibHash,
        configHash: decoded.configHash,
        tokenizerHash: decoded.tokenizerHash,
        ipfsCid: decoded.ipfsCid,
        licenseSpdx: decoded.licenseSpdx,
        priceMicroUsdc: decoded.priceMicroUsdc,
        version: decoded.version,
      };
    } catch (err) {
      // Decoding failure means the account exists at the right PDA but
      // doesn't match the schema this client knows — treat as a stub
      // hit so the badge stays honest.
      return {
        status: "unregistered",
        modelId,
        slot,
        error:
          err instanceof Error ? `decode failed: ${err.message}` : undefined,
      };
    }
  } catch (err) {
    return {
      status: "unreachable",
      modelId,
      error: err instanceof Error ? err.message : "rpc error",
    };
  }
}

// Decode the on-chain ModelRecord account body. Layout mirrors
// programs/ghola-model-registry/src/lib.rs::ModelRecord. The first
// 8 bytes are Anchor's account-discriminator and are skipped.
function decodeModelRecord(data: Uint8Array): {
  creator: string;
  weightsHash: string;
  modelLibHash: string;
  configHash: string;
  tokenizerHash: string;
  priceMicroUsdc: number;
  createdAt: number;
  updatedAt: number;
  version: number;
  modelId: string;
  ipfsCid: string;
  licenseSpdx: string;
} {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let off = 8; // skip Anchor discriminator

  const creatorBytes = data.slice(off, off + 32);
  off += 32;
  const weightsHash = bytesToHexLocal(data.slice(off, off + 32));
  off += 32;
  const modelLibHash = bytesToHexLocal(data.slice(off, off + 32));
  off += 32;
  const configHash = bytesToHexLocal(data.slice(off, off + 32));
  off += 32;
  const tokenizerHash = bytesToHexLocal(data.slice(off, off + 32));
  off += 32;

  const priceMicroUsdc = Number(view.getBigUint64(off, true));
  off += 8;
  const createdAt = Number(view.getBigInt64(off, true));
  off += 8;
  const updatedAt = Number(view.getBigInt64(off, true));
  off += 8;
  const version = view.getUint16(off, true);
  off += 2;

  const modelId = readBorshString(data, view, off);
  off = modelId.next;
  const ipfsCid = readBorshString(data, view, off);
  off = ipfsCid.next;
  const licenseSpdx = readBorshString(data, view, off);

  return {
    creator: new PublicKey(creatorBytes).toBase58(),
    weightsHash,
    modelLibHash,
    configHash,
    tokenizerHash,
    priceMicroUsdc,
    createdAt,
    updatedAt,
    version,
    modelId: modelId.value,
    ipfsCid: ipfsCid.value,
    licenseSpdx: licenseSpdx.value,
  };
}

function readBorshString(
  data: Uint8Array,
  view: DataView,
  offset: number,
): { value: string; next: number } {
  const len = view.getUint32(offset, true);
  const value = new TextDecoder().decode(data.slice(offset + 4, offset + 4 + len));
  return { value, next: offset + 4 + len };
}

function bytesToHexLocal(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}
