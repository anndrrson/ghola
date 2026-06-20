package xyz.ghola.app.solana

/**
 * Solana wallet + Seeker-specific package names.
 *
 * Originally inlined at `ChatActivity.kt:40-58` as part of the Phase-0
 * Seeker detection. Phase M4 moves them here so [MWAManager] and future
 * Solana-facing code can share the same canonical list.
 */
object SolanaConstants {

    /** Package signatures that identify a Solana Seeker device. */
    val SEEKER_INDICATOR_PACKAGES = listOf(
        "com.solanamobile.dappstore"
    )

    /** Known Solana wallet apps, in priority order for detection. */
    val WALLET_CANDIDATES = listOf(
        "com.solflare.mobile",
        "app.phantom"
    )

    /** Phantom deep-link scheme (iOS + Android). */
    const val PHANTOM_CONNECT_URI = "https://phantom.app/ul/v1/connect"

    /** Solflare deep-link scheme. */
    const val SOLFLARE_CONNECT_URI = "https://solflare.com/ul/v1/connect"

    /** The default cluster used for MWA authorize() calls. */
    const val DEFAULT_CLUSTER_DEVNET = "devnet"
    const val DEFAULT_CLUSTER_MAINNET = "mainnet-beta"
}
