package xyz.ghola.app.crypto

import android.content.Context
import android.util.Log

/**
 * Process-wide cache for [VaultStore] instances, keyed by user DID.
 *
 * Without this, every fresh [ChatActivity] instance constructs its own
 * VaultStore and (more painfully) calls [VaultStore.unlock] from scratch —
 * which triggers an MWA wallet signature prompt. Users on the Seeker reported
 * seeing the wallet pop up every single time they re-entered chat from the
 * home grid, even seconds after the previous unlock.
 *
 * The vault is **kept unlocked across activities for the process lifetime**.
 * Auto-lock fires after the configured idle TTL (default 15 min, see
 * [VaultStore.DEFAULT_IDLE_TTL_MILLIS]) on the next vault-touching call —
 * `maybeIdleLock` already enforces that.
 *
 * The wallet prompt now fires at most once per session, not once per chat
 * re-entry.
 */
object VaultStoreHolder {

    private const val TAG = "VaultStoreHolder"

    private val cache = mutableMapOf<String, VaultStore>()

    /**
     * Returns the cached [VaultStore] for [userDid], constructing one if we
     * haven't seen this DID before. The instance is not unlocked by this call —
     * callers must still invoke [VaultStore.unlock] when they need to derive
     * key material.
     */
    @Synchronized
    fun get(context: Context, userDid: String): VaultStore {
        cache[userDid]?.let { existing ->
            Log.d(TAG, "reusing cached VaultStore for $userDid (unlocked=${existing.isUnlocked()})")
            return existing
        }
        Log.i(TAG, "creating VaultStore for $userDid")
        val store = VaultStore.create(context.applicationContext, userDid)
        cache[userDid] = store
        return store
    }

    /** Force-lock and evict — used by sign-out flows. */
    @Synchronized
    fun lockAndEvict(userDid: String) {
        cache.remove(userDid)?.also {
            Log.i(TAG, "locking + evicting VaultStore for $userDid")
            it.lock()
        }
    }

    /** Lock every cached vault. */
    @Synchronized
    fun lockAll() {
        cache.values.forEach { it.lock() }
        cache.clear()
    }
}
