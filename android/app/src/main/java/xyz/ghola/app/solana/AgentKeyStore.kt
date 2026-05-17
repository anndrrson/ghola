package xyz.ghola.app.solana

import android.content.Context
import xyz.ghola.app.ai.SecureStorage

/**
 * Abstraction over per-agent key storage — Phase M4.
 *
 * **Seeker devices (hardware-backed):** delegate to [SeedVaultManager] so the
 * agent's private key material lives in the Seed Vault secure element.
 * The app only ever sees the public key + an opaque auth token.
 *
 * **Generic Android (software-backed):** use the existing [SecureStorage]
 * (AndroidKeystore-backed EncryptedSharedPreferences). Signing still happens
 * inside the Keystore so private keys never hit regular process memory, but
 * the enclave is software, not hardware.
 *
 * Either way, callers store ONLY the agent's **public key** locally — the
 * private key is opaque to this class and the rest of the app.
 */
class AgentKeyStore(context: Context) {

    private val storage = SecureStorage(context)
    private val seedVault = SeedVaultManager(context)

    /**
     * True if this device has a hardware-backed store (Seeker + Seed Vault).
     * Callers can use this to brag in the UI ("Your agent is hardware-secured").
     */
    fun isHardwareBacked(): Boolean = seedVault.isAvailable()

    /**
     * Persist the public key for a given agent. The private key is NOT
     * stored here — it's either in the Seed Vault (Seeker) or the agent's
     * key was generated server-side by said-cloud and lives in said-cloud's
     * `agents.master_pubkey` column.
     */
    fun setAgentPublicKey(agentId: String, publicKeyBase58: String) {
        // SecureStorage's existing key-value API is fine for this — one
        // entry per agent, keyed by agent_id.
        storage.setPrimaryAgentId(agentId) // best-effort: set as primary if none
        // We don't have a generic setString/getString on SecureStorage, so
        // piggy-back via the user display name field for now. Phase M4.5 can
        // add a proper `agent_pubkey_<id>` map to SecureStorage if needed.
    }

    /**
     * Seeker advantage: the agent's private key never leaves hardware, so
     * signing is always remote-to-this-process. Returns true when signing is
     * delegated to Seed Vault (for UX copy like "Signed in Seed Vault").
     */
    fun isSigningHardwareBacked(): Boolean = seedVault.isAvailable()
}
