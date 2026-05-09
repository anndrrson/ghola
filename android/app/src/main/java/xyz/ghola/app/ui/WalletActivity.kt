package xyz.ghola.app.ui

import android.os.Bundle
import android.view.View
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.google.android.material.bottomnavigation.BottomNavigationView
import com.google.android.material.button.MaterialButton
import com.solana.mobilewalletadapter.clientlib.ActivityResultSender
import kotlinx.coroutines.launch
import xyz.ghola.app.R
import xyz.ghola.app.ai.SecureStorage
import xyz.ghola.app.cloud.SaidCloudClient
import xyz.ghola.app.demo.DemoSeed
import xyz.ghola.app.solana.MWAConnect
import xyz.ghola.app.solana.SeedVaultManager
import xyz.ghola.app.solana.SolanaConstants
import java.util.concurrent.Executors

/**
 * Phase M6 — Wallet tab. v1 is read-only:
 *   - Detected wallet package (from existing Seeker detection logic)
 *   - Seed Vault availability flag (from SecureStorage.isSeeker)
 *   - Owned agent count (each agent has its own isolated wallet)
 *
 * MWA signing + Seed Vault hardware integration land in Phase M4.
 * For now this is a landing surface that tells the user what's wired up.
 */
class WalletActivity : AppCompatActivity() {

    private lateinit var storage: SecureStorage
    private lateinit var walletStatus: TextView
    private lateinit var deviceType: TextView
    private lateinit var seedVaultStatus: TextView
    private lateinit var walletPackage: TextView
    private lateinit var agentCount: TextView
    private lateinit var connectButton: MaterialButton
    private lateinit var connectStatus: TextView
    private lateinit var connectedPubkey: TextView
    private val executor = Executors.newSingleThreadExecutor()

    // ActivityResultSender MUST be constructed before the Activity enters
    // STARTED state so its internal `registerForActivityResult()` call
    // succeeds. Kotlin field initializers run during Java object
    // construction, AFTER ComponentActivity's constructor has set up the
    // ActivityResultRegistry — which is exactly when it's safe. Do NOT
    // convert this to `by lazy` or initialize inside onCreate; both land
    // after STARTED and raise IllegalStateException at runtime.
    private val activityResultSender = ActivityResultSender(this)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_wallet)

        storage = SecureStorage(this)

        walletStatus = findViewById(R.id.walletStatus)
        deviceType = findViewById(R.id.deviceType)
        seedVaultStatus = findViewById(R.id.seedVaultStatus)
        walletPackage = findViewById(R.id.walletPackage)
        agentCount = findViewById(R.id.agentCount)
        connectButton = findViewById(R.id.connectWalletButton)
        connectStatus = findViewById(R.id.connectStatus)
        connectedPubkey = findViewById(R.id.connectedPubkey)

        connectButton.setOnClickListener { startConnect() }

        val bottomNav = findViewById<BottomNavigationView>(R.id.bottomNav)
        BottomNavHelper.attach(this, R.id.tab_wallet, bottomNav)

        render()
        loadAgentCount()
    }

    /**
     * Fire the real MWA authorize flow. Launches the installed wallet
     * (Seed Vault on Seeker), waits for user approval, displays the
     * returned Solana address on success or a toast on failure.
     */
    private fun startConnect() {
        connectButton.isEnabled = false
        connectStatus.text = "Opening wallet…"
        connectedPubkey.text = ""

        lifecycleScope.launch {
            val result = MWAConnect.authorize(activityResultSender)
            connectButton.isEnabled = true
            result.fold(
                onSuccess = { address ->
                    connectStatus.text = "connected"
                    connectedPubkey.text = address
                    // Phase 0.3: persist so ChatActivity (E2E vault unlock)
                    // and PairDevice (handshake signing) can reuse the same
                    // authorized wallet without re-prompting the user.
                    storage.setSolanaAddress(address)
                },
                onFailure = { err ->
                    connectStatus.text = "not connected"
                    connectedPubkey.text = ""
                    val msg = when (err) {
                        is MWAConnect.NoWalletInstalledException ->
                            "No Solana wallet installed. Try Seed Vault on Seeker."
                        else -> err.message ?: "Authorization failed"
                    }
                    Toast.makeText(this@WalletActivity, msg, Toast.LENGTH_LONG).show()
                },
            )
        }
    }

    override fun onResume() {
        super.onResume()
        render()
        loadAgentCount()
    }

    private fun render() {
        // Live Seeker detection — don't rely on the cached flag from ChatActivity's
        // first-launch detection. Check package presence directly every time the
        // Wallet tab is opened.
        val pm = packageManager
        val seeker = SolanaConstants.SEEKER_INDICATOR_PACKAGES.any { pkgName ->
            try {
                pm.getPackageInfo(pkgName, 0)
                true
            } catch (_: Exception) {
                false
            }
        }
        storage.setIsSeeker(seeker)

        // Same for wallet package — find the first installed Solana wallet now.
        val installedWallet = SolanaConstants.WALLET_CANDIDATES.firstOrNull { pkgName ->
            try {
                pm.getPackageInfo(pkgName, 0)
                true
            } catch (_: Exception) {
                false
            }
        }
        if (installedWallet != null) {
            storage.setWalletPackage(installedWallet)
        }

        val seedVaultAvailable = SeedVaultManager(this).isAvailable()

        deviceType.text = if (seeker) "Solana Seeker" else "Android (non-Seeker)"
        seedVaultStatus.text = if (seedVaultAvailable) {
            "Seed Vault available — hardware-backed agent keys"
        } else if (seeker) {
            "Seeker detected (Seed Vault SDK not yet wired)"
        } else {
            "No Seed Vault — using encrypted shared prefs"
        }

        if (installedWallet != null) {
            walletPackage.text = installedWallet
            walletStatus.text = "Wallet detected"
        } else {
            walletPackage.text = "(none detected — install Solflare, Phantom, or Seed Vault)"
            walletStatus.text = "No wallet connected"
        }
    }

    private fun loadAgentCount() {
        // Demo-first: always show the seed agent count (3) immediately so the
        // huge 56sp number is never "—". Backend value, if present, replaces it.
        val seedCount = DemoSeed.agents().length()
        agentCount.text = seedCount.toString()

        if (!storage.hasSaidAuth()) return
        executor.execute {
            try {
                val client = SaidCloudClient(storage.getSaidBaseUrl(), storage.getSaidToken())
                val rows = client.listAgents()
                runOnUiThread {
                    val realCount = rows?.length() ?: 0
                    if (realCount > 0) agentCount.text = realCount.toString()
                }
            } catch (_: Exception) {
                // Seed value already rendered — swallow silently.
            }
        }
    }
}
