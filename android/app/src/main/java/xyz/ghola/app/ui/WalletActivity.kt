package xyz.ghola.app.ui

import android.os.Bundle
import android.view.View
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.Toolbar
import com.google.android.material.bottomnavigation.BottomNavigationView
import xyz.ghola.app.R
import xyz.ghola.app.ai.SecureStorage
import xyz.ghola.app.cloud.SaidCloudClient
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
    private val executor = Executors.newSingleThreadExecutor()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_wallet)

        storage = SecureStorage(this)

        val toolbar = findViewById<Toolbar>(R.id.toolbar)
        setSupportActionBar(toolbar)

        walletStatus = findViewById(R.id.walletStatus)
        deviceType = findViewById(R.id.deviceType)
        seedVaultStatus = findViewById(R.id.seedVaultStatus)
        walletPackage = findViewById(R.id.walletPackage)
        agentCount = findViewById(R.id.agentCount)

        val bottomNav = findViewById<BottomNavigationView>(R.id.bottomNav)
        BottomNavHelper.attach(this, R.id.tab_wallet, bottomNav)

        render()
        loadAgentCount()
    }

    override fun onResume() {
        super.onResume()
        render()
        loadAgentCount()
    }

    private fun render() {
        val seeker = storage.isSeeker()
        val pkg = storage.getWalletPackage()
        val hasWallet = !pkg.isNullOrBlank()

        deviceType.text = if (seeker) "Solana Seeker" else "Android (non-Seeker)"
        seedVaultStatus.text = if (seeker) {
            "Seed Vault available (hardware-backed keys)"
        } else {
            "No Seed Vault — using encrypted shared prefs"
        }

        if (hasWallet) {
            walletPackage.text = pkg
            walletStatus.text = "Wallet detected"
        } else {
            walletPackage.text = "(none detected — install Solflare, Phantom, or Seed Vault)"
            walletStatus.text = "No wallet connected"
        }
    }

    private fun loadAgentCount() {
        if (!storage.hasSaidAuth()) {
            agentCount.text = "Sign in to see your agents"
            return
        }
        executor.execute {
            val client = SaidCloudClient(storage.getSaidBaseUrl(), storage.getSaidToken())
            val rows = client.listAgents()
            runOnUiThread {
                agentCount.text = if (rows != null) "${rows.length()}" else "—"
            }
        }
    }
}
