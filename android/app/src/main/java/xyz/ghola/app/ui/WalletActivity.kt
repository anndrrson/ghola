package xyz.ghola.app.ui

import android.os.Bundle
import android.util.Base64 as AndroidBase64
import android.view.View
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.google.android.material.button.MaterialButton
import com.solana.mobilewalletadapter.clientlib.ActivityResultSender
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import xyz.ghola.app.BuildConfig
import xyz.ghola.app.R
import xyz.ghola.app.ai.SecureStorage
import xyz.ghola.app.cloud.CloudAuthManager
import xyz.ghola.app.cloud.DeviceSignerProvider
import xyz.ghola.app.cloud.PrivateWalletClient
import xyz.ghola.app.cloud.SaidCloudClient
import xyz.ghola.app.cloud.SeekerClient
import xyz.ghola.app.crypto.ChatHistoryStore
import xyz.ghola.app.crypto.Envelope
import xyz.ghola.app.crypto.VaultStoreHolder
import xyz.ghola.app.demo.DemoSeed
import xyz.ghola.app.market.PrivateAccountClient
import xyz.ghola.app.solana.Base58
import xyz.ghola.app.solana.MWAConnect
import xyz.ghola.app.solana.SolanaConstants
import java.util.concurrent.Executors

/**
 * Phase M6 — Wallet tab. v1 is read-only:
 *   - Detected wallet package (from existing Seeker detection logic)
 *   - Seeker availability flag (from SecureStorage.isSeeker)
 *   - Owned agent count (each agent has its own isolated wallet)
 *
 * MWA signing lands in Phase M4.
 * For now this is a landing surface that tells the user what's wired up.
 */
class WalletActivity : AppCompatActivity() {

    private lateinit var storage: SecureStorage
    private lateinit var walletStatus: TextView
    private lateinit var deviceType: TextView
    private lateinit var walletCapabilityStatus: TextView
    private lateinit var walletPackage: TextView
    private lateinit var agentCount: TextView
    private lateinit var connectButton: MaterialButton
    private lateinit var disconnectButton: MaterialButton
    private lateinit var connectStatus: TextView
    private lateinit var connectedPubkey: TextView
    private lateinit var verifySeekerButton: MaterialButton
    private lateinit var seekerVerificationStatus: TextView
    private lateinit var privateRailStatus: TextView
    private lateinit var privateRecipientInput: EditText
    private lateinit var privateAmountInput: EditText
    private lateinit var privateSelfTestButton: MaterialButton
    private lateinit var createPrivateIntentButton: MaterialButton
    private lateinit var privateIntentStatus: TextView
    private lateinit var privateHistory: TextView
    private lateinit var advancedWalletButton: MaterialButton
    private lateinit var advancedWalletSection: View
    private var advancedWalletVisible = false
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
        walletCapabilityStatus = findViewById(R.id.walletCapabilityStatus)
        walletPackage = findViewById(R.id.walletPackage)
        agentCount = findViewById(R.id.agentCount)
        connectButton = findViewById(R.id.connectWalletButton)
        disconnectButton = findViewById(R.id.disconnectWalletButton)
        connectStatus = findViewById(R.id.connectStatus)
        connectedPubkey = findViewById(R.id.connectedPubkey)
        verifySeekerButton = findViewById(R.id.verifySeekerButton)
        seekerVerificationStatus = findViewById(R.id.seekerVerificationStatus)
        privateRailStatus = findViewById(R.id.privateRailStatus)
        privateRecipientInput = findViewById(R.id.privateRecipientInput)
        privateAmountInput = findViewById(R.id.privateAmountInput)
        privateSelfTestButton = findViewById(R.id.privateSelfTestButton)
        createPrivateIntentButton = findViewById(R.id.createPrivateIntentButton)
        privateIntentStatus = findViewById(R.id.privateIntentStatus)
        privateHistory = findViewById(R.id.privateHistory)
        advancedWalletButton = findViewById(R.id.advancedWalletButton)
        advancedWalletSection = findViewById(R.id.advancedWalletSection)

        connectButton.setOnClickListener { startConnect() }
        disconnectButton.setOnClickListener { startDisconnect() }
        verifySeekerButton.setOnClickListener { startSeekerVerification() }
        privateSelfTestButton.setOnClickListener { startShieldedSelfTest() }
        createPrivateIntentButton.setOnClickListener { startPrivateUSDCxIntent() }
        advancedWalletButton.setOnClickListener { toggleAdvancedWallet() }

        findViewById<View>(R.id.bottomNav).visibility = View.GONE

        render()
        loadAgentCount()
    }

    /**
     * Fire the real MWA authorize flow. Launches the installed wallet,
     * waits for user approval, displays the
     * returned Solana address on success or a toast on failure.
     */
    private fun startConnect() {
        if (BuildConfig.GHOLA_PLAY_STORE_BUILD) {
            startTurnkeyConnect()
            return
        }
        connectButton.isEnabled = false
        connectStatus.text = "Opening wallet…"
        connectedPubkey.text = ""

        lifecycleScope.launch {
            val result = MWAConnect.authorizeSession(
                activityResultSender,
                previousAuthToken = storage.getMwaAuthToken(),
            )
            connectButton.isEnabled = true
            result.fold(
                onSuccess = { session ->
                    connectStatus.text = "connected"
                    connectedPubkey.text = session.address
                    storage.setMwaSession(
                        address = session.address,
                        authToken = session.authToken,
                        walletUriBase = session.walletUriBase,
                        accountLabel = session.accountLabel,
                        cluster = session.cluster,
                    )
                    connectStatus.text = "connected · approve sign-in"
                    when (val auth = CloudAuthManager(this@WalletActivity).signInWithWallet(activityResultSender, session.address)) {
                        is CloudAuthManager.AuthResult.Success -> {
                            connectStatus.text = "connected · signed in"
                        }
                        is CloudAuthManager.AuthResult.Error -> {
                            connectStatus.text = "connected · sign-in needed"
                            Toast.makeText(this@WalletActivity, auth.message, Toast.LENGTH_LONG).show()
                        }
                    }
                    render()
                },
                onFailure = { err ->
                    connectStatus.text = "not connected"
                    connectedPubkey.text = ""
                    val msg = when (err) {
                        is MWAConnect.NoWalletInstalledException ->
                            if (BuildConfig.GHOLA_SEEKER_BUILD) {
                                getString(R.string.wallet_missing_seeker)
                            } else {
                                getString(R.string.wallet_missing_standard)
                            }
                        else -> err.message ?: "Authorization failed"
                    }
                    Toast.makeText(this@WalletActivity, msg, Toast.LENGTH_LONG).show()
                },
            )
        }
    }

    private fun startTurnkeyConnect() {
        connectButton.isEnabled = false
        connectStatus.text = "Opening Turnkey…"
        connectedPubkey.text = ""
        lifecycleScope.launch {
            val auth = CloudAuthManager(this@WalletActivity).signInWithTurnkey(this@WalletActivity)
            connectButton.isEnabled = true
            when (auth) {
                is CloudAuthManager.AuthResult.Success -> {
                    connectStatus.text = "connected · signed in"
                    render()
                }
                is CloudAuthManager.AuthResult.Error -> {
                    connectStatus.text = "not connected"
                    Toast.makeText(this@WalletActivity, auth.message, Toast.LENGTH_LONG).show()
                    render()
                }
            }
        }
    }

    private fun startDisconnect() {
        val walletAddress = storage.getSolanaAddress()
        val userDid = walletDid(walletAddress)
        val authToken = storage.getMwaAuthToken()
        connectButton.isEnabled = false
        disconnectButton.isEnabled = false
        connectStatus.text = "Signing out..."
        lifecycleScope.launch {
            clearLocalLoginState(userDid)
            render()

            val result = runCatching {
                if (BuildConfig.GHOLA_PLAY_STORE_BUILD) {
                    DeviceSignerProvider.signOut(this@WalletActivity)
                    Result.success(Unit)
                } else {
                    MWAConnect.deauthorize(activityResultSender, authToken)
                }
            }.getOrElse { Result.failure(it) }

            if (BuildConfig.GHOLA_PLAY_STORE_BUILD) {
                storage.clearTurnkeySession()
            } else {
                storage.clearMwaSession()
            }
            connectButton.isEnabled = true
            disconnectButton.isEnabled = true
            result.onFailure { err ->
                Toast.makeText(
                    this@WalletActivity,
                    err.message ?: "Signed out locally",
                    Toast.LENGTH_LONG,
                ).show()
            }
            connectStatus.text = "signed out"
            render()
        }
    }

    private fun clearLocalLoginState(userDid: String?) {
        if (userDid != null) {
            VaultStoreHolder.lockAndEvict(userDid)
            runCatching { ChatHistoryStore.create(this).wipe(userDid) }
        } else {
            VaultStoreHolder.lockAll()
        }
        CloudAuthManager(this).signOut()
            storage.clearMwaSession()
            storage.clearTurnkeySession()
    }

    override fun onResume() {
        super.onResume()
        render()
        loadAgentCount()
        if (advancedWalletVisible) {
            loadPrivateWalletState()
        }
    }

    private fun toggleAdvancedWallet() {
        advancedWalletVisible = !advancedWalletVisible
        advancedWalletSection.visibility = if (advancedWalletVisible) View.VISIBLE else View.GONE
        advancedWalletButton.text = if (advancedWalletVisible) "Hide advanced" else "Advanced"
        if (advancedWalletVisible) {
            loadPrivateWalletState()
        }
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

        val showSeekerSurface = BuildConfig.GHOLA_SEEKER_BUILD && seeker

        deviceType.text = if (showSeekerSurface) {
            getString(R.string.wallet_device_seeker)
        } else {
            getString(R.string.wallet_device_standard)
        }
        walletCapabilityStatus.text = if (showSeekerSurface) {
            getString(R.string.wallet_status_seeker)
        } else {
            getString(R.string.wallet_status_standard)
        }

        val connectedAddress = storage.getSolanaAddress()
        val turnkeyAddress = storage.getTurnkeyAddress()

        if (BuildConfig.GHOLA_PLAY_STORE_BUILD && !turnkeyAddress.isNullOrBlank()) {
            walletPackage.text = "Turnkey"
            walletStatus.text = "Turnkey wallet connected"
        } else if (installedWallet != null) {
            walletPackage.text = installedWallet
            walletStatus.text = "Wallet detected"
        } else {
            walletPackage.text = "(${getString(R.string.wallet_package_missing)})"
            walletStatus.text = "No wallet connected"
        }

        if (connectedAddress.isNullOrBlank()) {
            connectStatus.text = "not connected"
            connectedPubkey.text = ""
            connectButton.text = if (showSeekerSurface) {
                getString(R.string.wallet_connect_seeker)
            } else {
                getString(R.string.wallet_connect_standard)
            }
            disconnectButton.visibility = View.GONE
            verifySeekerButton.isEnabled = false
        } else {
            val label = storage.getMwaAccountLabel()?.takeIf { it.isNotBlank() }
            connectStatus.text = buildString {
                append("connected")
                if (label != null) append(" · ").append(label)
                if (storage.hasCloudAuth()) {
                    append(" · signed in")
                } else {
                    append(" · sign-in needed")
                }
            }
            connectedPubkey.text = mask(connectedAddress)
            connectButton.text = if (showSeekerSurface) {
                getString(R.string.wallet_refresh_seeker)
            } else {
                getString(R.string.wallet_refresh_standard)
            }
            disconnectButton.visibility = View.VISIBLE
            verifySeekerButton.isEnabled = BuildConfig.GHOLA_SEEKER_BUILD
        }
        seekerVerificationStatus.text = if (!BuildConfig.GHOLA_SEEKER_BUILD) {
            getString(R.string.wallet_standard_proof_status)
        } else if (storage.hasVerifiedSeekerWallet()) {
            "verified SGT · ${mask(storage.getSeekerSgtMint().orEmpty())}"
        } else {
            "not verified yet"
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

    private fun loadPrivateWalletState() {
        privateRailStatus.text = "Loading private USDCx rail..."
        privateHistory.text = ""
        executor.execute {
            val client = PrivateWalletClient(
                storage.getThumperApiBaseUrl(),
                tokenProvider = { storage.getCloudAuthToken() },
            )
            val railText = runCatching { describePrivateRail(client.paymentHealth()) }
                .getOrElse { "Private USDCx status unavailable: ${it.message ?: "unknown error"}" }
            val historyText = if (storage.getCloudAuthToken().isNullOrBlank()) {
                "Sign in with ${walletApprovalLabel()} to load private transfer history."
            } else {
                runCatching { describePrivateHistory(client.privateHistory()) }
                    .getOrElse { "Private history unavailable: ${it.message ?: "unknown error"}" }
            }
            runOnUiThread {
                privateRailStatus.text = railText
                privateHistory.text = historyText
            }
        }
    }

    private fun startPrivateUSDCxIntent() {
        val recipient = privateRecipientInput.text.toString().trim()
        val amount = parseMicroUSDC(privateAmountInput.text.toString())
        val walletAddress = storage.getSolanaAddress()
        val signerDid = walletDid(walletAddress)
        when {
            walletAddress.isNullOrBlank() || signerDid == null -> {
                Toast.makeText(this, "Connect ${walletApprovalLabel()} first", Toast.LENGTH_LONG).show()
                return
            }
            storage.getCloudAuthToken().isNullOrBlank() -> {
                Toast.makeText(this, "Sign in with ${walletApprovalLabel()} first", Toast.LENGTH_LONG).show()
                return
            }
            !isPrivateRecipientForBuild(recipient) -> {
                Toast.makeText(this, privateRecipientErrorForBuild(), Toast.LENGTH_LONG).show()
                return
            }
            amount == null || amount <= 0L -> {
                Toast.makeText(this, "Enter a USDCx amount greater than zero", Toast.LENGTH_LONG).show()
                return
            }
        }
        val approvedWalletAddress = walletAddress ?: return
        val approvedAmount = amount ?: return
        val approvedSignerDid = signerDid ?: return

        createPrivateIntentButton.isEnabled = false
        privateIntentStatus.text = "Waiting for ${walletApprovalLabel()} approval..."
        val privateRail = privateRailForBuild()
        val approvalMessage = buildString {
            append(if (BuildConfig.GHOLA_SEEKER_BUILD) "Ghola Seeker private USDCx intent\n" else "Ghola Android private USDCx intent\n")
            append("rail=").append(privateRail).append('\n')
            append("amount_micro_usdc=").append(approvedAmount).append('\n')
            append("to=").append(recipient).append('\n')
            append("signer=").append(approvedSignerDid).append('\n')
            append("fallback_allowed=false")
        }

        lifecycleScope.launch {
            if (BuildConfig.GHOLA_PLAY_STORE_BUILD) {
                val signer = DeviceSignerProvider.cached(this@WalletActivity)
                    ?: DeviceSignerProvider.signIn(this@WalletActivity).getOrElse {
                        privateIntentFailed(it.message ?: "Turnkey approval failed")
                        return@launch
                    }
                when (val signed = signer.sign(approvalMessage.toByteArray(Charsets.UTF_8))) {
                    is xyz.ghola.app.cloud.DeviceSignResult.Success -> {
                        val sig = AndroidBase64.encodeToString(signed.signature, AndroidBase64.NO_WRAP)
                        createPrivateIntent(recipient, approvedAmount, approvedSignerDid, sig)
                    }
                    xyz.ghola.app.cloud.DeviceSignResult.NoSigner -> privateIntentFailed("No ${walletApprovalLabel()} found")
                    xyz.ghola.app.cloud.DeviceSignResult.Declined -> privateIntentFailed("${walletApprovalLabel()} approval declined")
                    xyz.ghola.app.cloud.DeviceSignResult.Cancelled -> privateIntentFailed("${walletApprovalLabel()} approval cancelled")
                    is xyz.ghola.app.cloud.DeviceSignResult.Failure ->
                        privateIntentFailed(signed.cause.message ?: "${walletApprovalLabel()} approval failed")
                }
                return@launch
            }

            when (val signed = signWithNativeWalletFirst(approvedWalletAddress, approvalMessage.toByteArray(Charsets.UTF_8))) {
                is MWAConnect.SignOutcome.Success -> {
                    val sig = AndroidBase64.encodeToString(signed.signature, AndroidBase64.NO_WRAP)
                    createPrivateIntent(recipient, approvedAmount, approvedSignerDid, sig)
                }
                MWAConnect.SignOutcome.NoWallet -> privateIntentFailed("No ${walletApprovalLabel()} found")
                MWAConnect.SignOutcome.Declined -> privateIntentFailed("${walletApprovalLabel()} approval declined")
                MWAConnect.SignOutcome.Cancelled -> privateIntentFailed("${walletApprovalLabel()} approval cancelled")
                is MWAConnect.SignOutcome.Failure ->
                    privateIntentFailed(signed.cause.message ?: "${walletApprovalLabel()} approval failed")
            }
        }
    }

    private fun startShieldedSelfTest() {
        privateIntentStatus.text = if (BuildConfig.GHOLA_SEEKER_BUILD) {
            "Private proof self-test is disabled in this dApp Store build."
        } else {
            getString(R.string.wallet_standard_proof_status)
        }
    }

    private fun startSeekerVerification() {
        if (!BuildConfig.GHOLA_SEEKER_BUILD) {
            verifySeekerButton.isEnabled = false
            seekerVerificationStatus.text = getString(R.string.wallet_standard_proof_status)
            Toast.makeText(this, getString(R.string.wallet_seeker_only_toast), Toast.LENGTH_LONG).show()
            return
        }
        val walletAddress = storage.getSolanaAddress()
        if (walletAddress.isNullOrBlank()) {
            Toast.makeText(this, "Connect Seeker Wallet first", Toast.LENGTH_LONG).show()
            return
        }
        if (storage.getCloudAuthToken().isNullOrBlank()) {
            Toast.makeText(this, "Sign in with Seeker Wallet first", Toast.LENGTH_LONG).show()
            return
        }
        val message = buildString {
            append("Ghola Seeker verification\n")
            append("wallet=").append(walletAddress).append('\n')
            append("domain=ghola.xyz\n")
            append("purpose=verify_seeker_genesis_token\n")
            append("nonce=").append(java.util.UUID.randomUUID())
        }
        verifySeekerButton.isEnabled = false
        seekerVerificationStatus.text = "Binding Seeker Wallet to Ghola Cloud..."
        lifecycleScope.launch {
            bindPrivateAccountWallet(walletAddress).getOrElse {
                seekerVerifyFailed(it.message ?: "Seeker Wallet binding failed")
                return@launch
            }
            seekerVerificationStatus.text = "Waiting for Seeker Wallet proof..."
            val signed = signWithNativeWalletFirst(walletAddress, message.toByteArray(Charsets.UTF_8))
            when (signed) {
                is MWAConnect.SignOutcome.Success -> {
                    val sig = AndroidBase64.encodeToString(signed.signature, AndroidBase64.NO_WRAP)
                    submitSeekerVerification(walletAddress, message, sig)
                }
                MWAConnect.SignOutcome.NoWallet -> seekerVerifyFailed("No Seeker Wallet found")
                MWAConnect.SignOutcome.Declined -> seekerVerifyFailed("Seeker Wallet proof declined")
                MWAConnect.SignOutcome.Cancelled -> seekerVerifyFailed("Seeker Wallet proof cancelled")
                is MWAConnect.SignOutcome.Failure ->
                    seekerVerifyFailed(signed.cause.message ?: "Seeker Wallet proof failed")
            }
        }
    }

    private suspend fun bindPrivateAccountWallet(walletAddress: String): Result<Unit> {
        val client = PrivateAccountClient(
            baseUrl = storage.getCloudBaseUrl(),
            tokenProvider = { storage.getCloudAuthToken() },
        )
        val challenge = client.fetchMobileWalletBindingChallenge(walletAddress).getOrElse {
            return Result.failure(it)
        }
        val message = challenge.optString("message").takeIf { it.isNotBlank() }
            ?: return Result.failure(IllegalStateException("Wallet binding challenge was empty."))
        val signed = signWithNativeWalletFirst(walletAddress, message.toByteArray(Charsets.UTF_8))
        val signature = when (signed) {
            is MWAConnect.SignOutcome.Success ->
                AndroidBase64.encodeToString(signed.signature, AndroidBase64.NO_WRAP)
            MWAConnect.SignOutcome.NoWallet ->
                return Result.failure(IllegalStateException("No Seeker Wallet found."))
            MWAConnect.SignOutcome.Declined ->
                return Result.failure(IllegalStateException("Seeker Wallet binding declined."))
            MWAConnect.SignOutcome.Cancelled ->
                return Result.failure(IllegalStateException("Seeker Wallet binding cancelled."))
            is MWAConnect.SignOutcome.Failure ->
                return Result.failure(signed.cause)
        }
        val bound = client.bindMobileWallet(walletAddress, message, signature)
        return if (bound.ok) {
            Result.success(Unit)
        } else {
            Result.failure(IllegalStateException(bound.error ?: "Seeker Wallet binding failed."))
        }
    }

    private suspend fun signWithNativeWalletFirst(
        walletAddress: String,
        message: ByteArray,
    ): MWAConnect.SignOutcome {
        return MWAConnect.signMessageDetached(
            activityResultSender,
            walletAddress,
            message,
            storage.getMwaAuthToken(),
        )
    }

    private fun submitSeekerVerification(walletAddress: String, message: String, signatureB64: String) {
        seekerVerificationStatus.text = "Checking Seeker Genesis Token..."
        executor.execute {
            val result = runCatching {
                SeekerClient(
                    storage.getThumperApiBaseUrl(),
                    tokenProvider = { storage.getCloudAuthToken() },
                ).verify(walletAddress, message, signatureB64)
            }
            runOnUiThread {
                verifySeekerButton.isEnabled = true
                result.fold(
                    onSuccess = { json ->
                        if (json.optBoolean("verified", false)) {
                            val mint = json.optString("sgt_mint", "")
                            storage.setSeekerVerified(mint.ifBlank { null })
                            seekerVerificationStatus.text = "verified SGT · ${mask(mint)}"
                        } else {
                            seekerVerificationStatus.text = json.optString("reason")
                                .ifBlank { "No Seeker Genesis Token found" }
                        }
                    },
                    onFailure = { err ->
                        seekerVerificationStatus.text = err.message ?: "Seeker verification failed"
                    },
                )
            }
        }
    }

    private fun seekerVerifyFailed(message: String) {
        verifySeekerButton.isEnabled = true
        seekerVerificationStatus.text = message
    }

    private fun createPrivateIntent(
        recipient: String,
        amountMicroUsdc: Long,
        signerDid: String,
        approvalSignatureB64: String,
    ) {
        privateIntentStatus.text = "Creating fail-closed private intent..."
        val summary = buildString {
            append(walletApprovalLabel())
            append(" approved private USDCx intent for ")
            append(formatMicroUSDC(amountMicroUsdc))
            append(" to ")
            append(mask(recipient))
            append(". No public USDC fallback. signer=")
            append(mask(signerDid))
            append(" approval_sig_b64=")
            append(approvalSignatureB64)
        }
        executor.execute {
            val client = PrivateWalletClient(
                storage.getThumperApiBaseUrl(),
                tokenProvider = { storage.getCloudAuthToken() },
            )
            val result = runCatching {
                client.createPrivateUSDCxIntent(
                    recipient,
                    amountMicroUsdc,
                    signerDid,
                    summary,
                    rail = privateRailForBuild(),
                    signingMode = privateSigningModeForBuild(),
                )
            }
            runOnUiThread {
                result.fold(
                    onSuccess = { json ->
                        if (BuildConfig.GHOLA_SEEKER_BUILD) {
                            createPrivateIntentButton.isEnabled = true
                            privateIntentStatus.text = "Private USDCx intent ${json.optString("status", "created")} · wallet approved · no public fallback"
                            loadPrivateWalletState()
                        } else {
                            createPrivateIntentButton.isEnabled = true
                            privateIntentStatus.text = "Private USDCx intent ${json.optString("status", "created")} · ${json.optString("recipient_preview", mask(recipient))}"
                            loadPrivateWalletState()
                        }
                    },
                    onFailure = { err ->
                        createPrivateIntentButton.isEnabled = true
                        privateIntentStatus.text = err.message ?: "Private intent failed"
                    },
                )
            }
        }
    }

    private fun privateIntentFailed(message: String) {
        createPrivateIntentButton.isEnabled = true
        privateIntentStatus.text = message
    }

    private fun privateRailForBuild(): String =
        if (BuildConfig.GHOLA_SEEKER_BUILD) "solana_shielded_pool" else "aleo_usdcx_shielded"

    private fun privateSigningModeForBuild(): String =
        if (BuildConfig.GHOLA_SEEKER_BUILD) "mwa_wallet" else "aleo_device"

    private fun isPrivateRecipientForBuild(recipient: String): Boolean {
        if (BuildConfig.GHOLA_SEEKER_BUILD) {
            return (recipient.startsWith("shld1") && recipient.length >= 32) ||
                runCatching { Base58.decode(recipient).size == 32 }.getOrDefault(false)
        }
        return recipient.startsWith("aleo1") && recipient.length >= 32
    }

    private fun privateRecipientErrorForBuild(): String =
        if (BuildConfig.GHOLA_SEEKER_BUILD) {
            "Enter a valid Solana shielded recipient"
        } else {
            "Enter a valid Aleo private address"
        }

    private fun describePrivateRail(health: JSONObject): String {
        val rails = health.optJSONObject("rails")
        val selectedRail = privateRailForBuild()
        val privateRail = rails?.optJSONObject(selectedRail)
            ?: if (BuildConfig.GHOLA_SEEKER_BUILD) {
                null
            } else {
                rails?.optJSONObject("aleo_usdcx_shielded")
                    ?: rails?.optJSONObject("private_usdcx")
            }
        if (privateRail == null) {
            return "Private USDCx is fail-closed until $selectedRail is advertised."
        }
        val ready = privateRail.optBoolean(
            "ready",
            privateRail.optBoolean("configured", false),
        )
        val network = privateRail.optString(
            "network",
            if (BuildConfig.GHOLA_SEEKER_BUILD) "solana:devnet" else "Aleo",
        )
        val provider = privateRail.optString(
            "provider",
            if (BuildConfig.GHOLA_SEEKER_BUILD) "solana_shielded_pool" else "aleo",
        )
        val reason = privateRail.optString("unavailable_reason", "")
        return if (ready) {
            "Private USDCx ready on $network via $provider. User-held ${walletApprovalLabel()} signs approvals."
        } else {
            "Private USDCx gated on $network via $provider. ${reason.ifBlank { "No public USDC fallback." }}"
        }
    }

    private fun walletApprovalLabel(): String =
        if (BuildConfig.GHOLA_SEEKER_BUILD) {
            getString(R.string.wallet_auth_label_seeker)
        } else {
            getString(R.string.wallet_auth_label_standard)
        }

    private fun describePrivateHistory(rows: JSONArray): String {
        if (rows.length() == 0) return "No private USDCx transfers yet."
        val lines = mutableListOf<String>()
        val count = minOf(rows.length(), 5)
        for (i in 0 until count) {
            val row = rows.optJSONObject(i) ?: continue
            val fallbackRecipient = if (BuildConfig.GHOLA_SEEKER_BUILD) "shld1..." else "aleo1..."
            lines += "${formatMicroUSDC(row.optLong("amount_micro_usdc"))} ${row.optString("asset", "USDCx")} · ${row.optString("status", "unknown")} · ${row.optString("recipient_preview", fallbackRecipient)}"
        }
        return lines.joinToString("\n")
    }

    private fun walletDid(address: String?): String? {
        if (address.isNullOrBlank()) return null
        return runCatching { Envelope.didKeyFromVerifying(Base58.decode(address)) }.getOrNull()
    }

    private fun parseMicroUSDC(raw: String): Long? {
        val normalized = raw.trim()
        if (normalized.isEmpty()) return null
        val parts = normalized.split('.', limit = 2)
        val whole = parts.getOrNull(0)?.takeIf { it.isNotEmpty() }?.toLongOrNull() ?: return null
        val fraction = parts.getOrNull(1).orEmpty()
        if (fraction.length > 6 || fraction.any { it !in '0'..'9' }) return null
        return whole * 1_000_000L + fraction.padEnd(6, '0').toLong()
    }

    private fun formatMicroUSDC(value: Long): String {
        val whole = value / 1_000_000L
        val cents = ((value % 1_000_000L) / 10_000L).toString().padStart(2, '0')
        return "${'$'}$whole.$cents USDCx"
    }

    private fun mask(raw: String): String {
        val value = raw.trim()
        if (value.length <= 12) return value
        return "${value.take(6)}...${value.takeLast(6)}"
    }
}
