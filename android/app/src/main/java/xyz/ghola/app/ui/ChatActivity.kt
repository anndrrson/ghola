package xyz.ghola.app.ui

import android.content.Intent
import android.os.Bundle
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.ImageButton
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.Toolbar
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import android.util.Log
import com.google.android.material.button.MaterialButton
import com.solana.mobilewalletadapter.clientlib.ActivityResultSender
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import xyz.ghola.app.BuildConfig
import xyz.ghola.app.R
import xyz.ghola.app.ai.AgentController
import xyz.ghola.app.ai.EnvelopeCloudBackend
import xyz.ghola.app.ai.FastMatch
import xyz.ghola.app.ai.AgentListener
import xyz.ghola.app.ai.ClaudeApiClient
import xyz.ghola.app.ai.CloudLlmBackend
import xyz.ghola.app.ai.LlmBackend
import xyz.ghola.app.ai.OpenAIApiClient
import xyz.ghola.app.ai.LocalToolExecutor
import xyz.ghola.app.ai.ModelStatus
import xyz.ghola.app.ai.PinnedModelHashes
import xyz.ghola.app.ai.SecureStorage
import xyz.ghola.app.ai.ToolFriendlyNames
import xyz.ghola.app.ai.litert.LiteRTNeuroPilotBackend
import xyz.ghola.app.ai.litert.LiteRtModelManager
import xyz.ghola.app.ai.litert.LiteRtNpuDispatcher
import xyz.ghola.app.ai.llama.LocalLlamaBackend
import xyz.ghola.app.ai.llama.ModelManager
import xyz.ghola.app.cloud.CloudAuthManager
import xyz.ghola.app.cloud.DeviceSignerProvider
import xyz.ghola.app.cloud.TaskClassifier
import xyz.ghola.app.cloud.ThumperCloudClient
import xyz.ghola.app.crypto.Envelope
import xyz.ghola.app.crypto.VaultStore
import xyz.ghola.app.crypto.VaultStoreHolder
import xyz.ghola.app.crypto.mwaSignerForVault
import xyz.ghola.app.service.ThumperAccessibilityService
import xyz.ghola.app.solana.Base58
import xyz.ghola.app.ui.components.IntegrityBadge
import xyz.ghola.app.ui.components.IntegrityBadgeDetailDialog

class ChatActivity : AppCompatActivity(), AgentListener {

    companion object {
        private const val TAG = "ChatActivity"

        // Wallet package candidates in priority order (Seeker + general crypto)
        private val WALLET_CANDIDATES = listOf(
            "com.solflare.mobile",
            "app.phantom"
        )

        // Keywords in app labels that indicate a Solana wallet
        private val WALLET_LABEL_KEYWORDS = listOf(
            "solflare", "phantom", "wallet"
        )

        // Packages that indicate this is a Solana Seeker device
        private val SEEKER_INDICATOR_PACKAGES = listOf(
            "com.solanamobile.dappstore"
        )

        /**
         * Pure helper: project a backend-mode string into the
         * [IntegrityArgs] tag we use to decide what to do with the badge.
         * Lives on the companion (not as an instance method) so it's
         * testable from a plain JVM JUnit suite without touching Android
         * internals.
         *
         * Unknown / future backend strings fall through to [IntegrityArgs.Cloud]
         * — safer to hide the chip than to assert against an artifact we
         * don't have a manager for.
         */
        @JvmStatic
        fun integrityArgsForBackend(backendMode: String): IntegrityArgs = when (backendMode) {
            SecureStorage.BACKEND_LOCAL -> IntegrityArgs.LocalLlama
            SecureStorage.BACKEND_LITERT_NPU -> IntegrityArgs.LiteRtNpu
            SecureStorage.BACKEND_CLOUD,
            SecureStorage.BACKEND_QWEN_CLOUD,
            SecureStorage.BACKEND_E2E_CLOUD -> IntegrityArgs.Cloud
            else -> IntegrityArgs.Cloud
        }
    }

    /**
     * Which on-device backend a [SecureStorage] backend-mode string
     * corresponds to from the IntegrityBadge's point of view.
     *
     * Cloud backends ([SecureStorage.BACKEND_CLOUD],
     * [SecureStorage.BACKEND_QWEN_CLOUD], [SecureStorage.BACKEND_E2E_CLOUD])
     * map to [Cloud] — the badge hides itself because the artifact
     * lives on someone else's GPU and an on-device hash is meaningless.
     *
     * On-device backends ([SecureStorage.BACKEND_LOCAL],
     * [SecureStorage.BACKEND_LITERT_NPU]) carry a real artifact whose
     * SHA-256 we can compute against [PinnedModelHashes].
     *
     * Declared as a nested class on the outer activity (rather than
     * inside the companion) so unit tests can reference
     * `ChatActivity.IntegrityArgs.Cloud` without going through
     * `ChatActivity.Companion`.
     */
    sealed class IntegrityArgs {
        /** Cloud backend — badge is hidden. */
        object Cloud : IntegrityArgs()

        /** llama.cpp / GGUF on-device backend. */
        object LocalLlama : IntegrityArgs()

        /** LiteRT-LM NPU on-device backend. */
        object LiteRtNpu : IntegrityArgs()
    }

    private lateinit var secureStorage: SecureStorage
    private lateinit var chatRecyclerView: RecyclerView
    private lateinit var messageInput: EditText
    private lateinit var sendButton: ImageButton
    private lateinit var statusPanel: View
    private lateinit var statusBar: TextView
    private lateinit var statusActionButton: MaterialButton
    private lateinit var chatAdapter: ChatAdapter
    private lateinit var integrityBadge: IntegrityBadge
    private lateinit var backendNameText: TextView
    private lateinit var chatTitle: TextView
    private var promptedAccessibilityThisSession = false

    /**
     * Cached snapshot from the most recent [refreshIntegrityBadge] so the
     * badge's click handler can pop the [IntegrityBadgeDetailDialog] with
     * the same hash + path it last rendered, without re-running the
     * (expensive) SHA-256 hash on every tap. Re-verify re-populates this.
     */
    private data class IntegritySnapshot(
        val status: ModelStatus,
        val artifactName: String,
        val artifactPath: String?,
        val fullHash: String?,
    )

    @Volatile
    private var lastIntegritySnapshot: IntegritySnapshot? = null

    // ActivityResultSender MUST be a field initializer (not lazy/onCreate)
    // — see WalletActivity for the same constraint. It registers an
    // activity-result handler at construction time so the MWA SDK can
    // dispatch the wallet's intent result back to us.
    private val activityResultSender = ActivityResultSender(this)

    private var agentController: AgentController? = null
    private var localBackend: LocalLlamaBackend? = null
    private var vaultStore: VaultStore? = null
    private var currentStreamingText = StringBuilder()
    private val intentCache = HashMap<String, Intent?>()
    private var pendingScreenshot: String? = null
    private var lastToolWasExplicitScreenshot = false
    private var isSigningIntoCloud = false
    private var statusAction: (() -> Unit)? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_chat)

        val toolbar = findViewById<Toolbar>(R.id.toolbar)
        setSupportActionBar(toolbar)

        secureStorage = SecureStorage(this)

        chatRecyclerView = findViewById(R.id.chatRecyclerView)
        messageInput = findViewById(R.id.messageInput)
        sendButton = findViewById(R.id.sendButton)
        statusPanel = findViewById(R.id.statusPanel)
        statusBar = findViewById(R.id.statusBar)
        statusActionButton = findViewById(R.id.statusActionButton)
        statusActionButton.setOnClickListener { statusAction?.invoke() }

        integrityBadge = findViewById(R.id.integrityBadge)
        backendNameText = findViewById(R.id.backendNameText)
        chatTitle = findViewById(R.id.chatTitle)
        applyQuickActionMode(intent.getStringExtra("quick_action"))
        integrityBadge.onBadgeClick = Runnable {
            val snap = lastIntegritySnapshot ?: return@Runnable
            IntegrityBadgeDetailDialog.show(
                context = this,
                status = snap.status,
                artifactName = snap.artifactName,
                artifactPath = snap.artifactPath,
                fullHash = snap.fullHash,
                onReverify = Runnable { refreshIntegrityBadge() },
            )
        }

        chatAdapter = ChatAdapter()
        val layoutManager = LinearLayoutManager(this).apply {
            stackFromEnd = true
        }
        chatRecyclerView.layoutManager = layoutManager
        chatRecyclerView.adapter = chatAdapter

        chatAdapter.onScrollToBottom = {
            chatRecyclerView.post {
                if (chatAdapter.itemCount > 0) {
                    chatRecyclerView.smoothScrollToPosition(chatAdapter.itemCount - 1)
                }
            }
        }

        sendButton.setOnClickListener { sendMessage() }

        messageInput.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_SEND) {
                sendMessage()
                true
            } else {
                false
            }
        }

        // Phase γ.3 — render the IntegrityBadge against the active
        // backend's artifact. Safe to call before checkPrerequisites()
        // runs the agent: this just hashes a file on Dispatchers.IO.
        refreshIntegrityBadge()

        // Handle prefill from HomeActivity voice input or quick actions
        intent.getStringExtra("prefill_message")?.let { prefill ->
            messageInput.setText(prefill)
        }
    }

    private fun applyQuickActionMode(mode: String?) {
        when (mode) {
            "markets" -> {
                chatTitle.text = "ghola / markets"
                messageInput.hint = "Ask for a market brief"
            }
            "trade" -> {
                chatTitle.text = "ghola / trade"
                messageInput.hint = "Describe the trade setup"
            }
            else -> {
                chatTitle.text = "ghola / chat"
                messageInput.hint = "Ask Ghola"
            }
        }
    }

    override fun onResume() {
        super.onResume()
        checkPrerequisites(allowWalletApproval = false)
        // The user may have switched backends in Settings while we were
        // paused — re-hash and re-bind the badge so it tells the truth.
        refreshIntegrityBadge()
    }

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menuInflater.inflate(R.menu.chat_menu, menu)
        return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        return when (item.itemId) {
            R.id.action_settings -> {
                startActivity(Intent(this, SettingsActivity::class.java))
                true
            }
            R.id.action_clear -> {
                chatAdapter.clear()
                agentController?.clearHistory()
                true
            }
            else -> super.onOptionsItemSelected(item)
        }
    }

    override fun onStop() {
        super.onStop()
        // Clear conversation history when user leaves the app so a fresh
        // session starts on return (prevents stale context issues).
        agentController?.clearHistory()
    }

    override fun onDestroy() {
        super.onDestroy()
        agentController?.shutdown()
        localBackend?.shutdown()
    }

    /**
     * Re-hash the active on-device artifact and re-bind the
     * [IntegrityBadge] in the toolbar. Cloud backends hide the chip —
     * the badge has nothing useful to say about a model we never
     * received bytes for. On-device backends drop into [Dispatchers.IO]
     * to stream the SHA-256 (the GGUF is ~1.6 GB; we never want this
     * on the UI thread), then marshal back to update the View.
     *
     * Safe to call repeatedly: every invocation recomputes from scratch
     * and overwrites [lastIntegritySnapshot], which the click handler
     * reads to populate [IntegrityBadgeDetailDialog].
     */
    private fun refreshIntegrityBadge() {
        val mode = activeBackendMode()
        val tag = integrityArgsForBackend(mode)

        when (tag) {
            IntegrityArgs.Cloud -> {
                integrityBadge.visibility = View.GONE
                backendNameText.text = backendDisplayNameForMode(mode)
                lastIntegritySnapshot = null
            }
            IntegrityArgs.LocalLlama -> {
                backendNameText.text = backendDisplayNameForMode(mode)
                integrityBadge.visibility = View.VISIBLE
                val mgr = ModelManager(this)
                lifecycleScope.launch {
                    val (status, path) = withContext(Dispatchers.IO) {
                        val s = runCatching { mgr.isModelVerified() }.getOrNull()
                            ?: ModelStatus.NOT_DOWNLOADED
                        val p = runCatching { mgr.getModelPath() }.getOrNull()
                        s to p
                    }
                    val fullHash = PinnedModelHashes.QWEN_2_5_1_5B_Q8_GGUF_SHA256
                    val artifact = "qwen2.5-1.5b-instruct-q8_0.gguf"
                    integrityBadge.bind(status, artifact, fullHash?.take(8))
                    lastIntegritySnapshot = IntegritySnapshot(
                        status = status,
                        artifactName = artifact,
                        artifactPath = path,
                        fullHash = fullHash,
                    )
                }
            }
            IntegrityArgs.LiteRtNpu -> {
                val mgr = LiteRtModelManager(this)
                backendNameText.text = mgr.activeVariant.displayName
                integrityBadge.visibility = View.VISIBLE
                lifecycleScope.launch {
                    val (status, path) = withContext(Dispatchers.IO) {
                        val s = runCatching { mgr.isModelVerified() }.getOrNull()
                            ?: ModelStatus.NOT_DOWNLOADED
                        val p = runCatching { mgr.getModelPath() }.getOrNull()
                        s to p
                    }
                    val fullHash = PinnedModelHashes.forVariant(mgr.activeVariant)
                    integrityBadge.bind(status, mgr.activeVariant.filename, fullHash?.take(8))
                    lastIntegritySnapshot = IntegritySnapshot(
                        status = status,
                        artifactName = mgr.activeVariant.filename,
                        artifactPath = path,
                        fullHash = fullHash,
                    )
                }
            }
        }
    }

    /**
     * Friendly label for the active backend, used in the toolbar TextView
     * alongside the badge. Mirrors each backend's `LlmBackend.displayName`
     * so the user sees the same string the AgentController logs against.
     */
    private fun backendDisplayNameForMode(mode: String): String = when (mode) {
        SecureStorage.BACKEND_LOCAL -> "On-device (Qwen 2.5 1.5B)"
        SecureStorage.BACKEND_LITERT_NPU -> "On-device NPU (Gemma-3-1B)"
        SecureStorage.BACKEND_E2E_CLOUD -> "Strict encrypted cloud"
        SecureStorage.BACKEND_QWEN_CLOUD -> "Qwen (Cloud)"
        SecureStorage.BACKEND_CLOUD -> "Claude (Cloud)"
        else -> ""
    }

    private fun activeBackendMode(): String {
        if (secureStorage.hasExplicitBackendMode()) return secureStorage.getBackendMode()
        val npu = LiteRtModelManager(this)
        if (runCatching { npu.isModelDownloaded() }.getOrDefault(false)) {
            return SecureStorage.BACKEND_LITERT_NPU
        }
        val local = ModelManager(this)
        if (runCatching { local.isModelDownloaded() }.getOrDefault(false)) {
            return SecureStorage.BACKEND_LOCAL
        }
        return SecureStorage.BACKEND_E2E_CLOUD
    }

    private fun checkPrerequisites(allowWalletApproval: Boolean = false) {
        if (agentController != null) return
        val mode = activeBackendMode()
        if (mode == SecureStorage.BACKEND_E2E_CLOUD) {
            if (!secureStorage.hasSolanaAddress()) {
                if (BuildConfig.GHOLA_PLAY_STORE_BUILD) {
                    showStatusAction(
                        "Connect with Turnkey to enable encrypted chat.",
                        "Connect",
                    ) { signInToCloudThenInitialize() }
                } else {
                    showStatusAction(
                        "Connect a Solana wallet to enable encrypted chat.",
                        "Connect",
                    ) { startActivity(Intent(this, WalletActivity::class.java)) }
                }
                return
            }
            if (!secureStorage.hasCloudAuth()) {
                showStatusAction(
                    "Sign in to Ghola Cloud to enable encrypted chat.",
                    "Sign in",
                ) { signInToCloudThenInitialize() }
                return
            }
        } else if (mode == SecureStorage.BACKEND_LOCAL) {
            val modelManager = ModelManager(this)
            if (!modelManager.isModelDownloaded()) {
                Toast.makeText(this, "Please download the model in Settings", Toast.LENGTH_LONG).show()
                startActivity(Intent(this, SettingsActivity::class.java))
                return
            }
        } else if (mode == SecureStorage.BACKEND_LITERT_NPU) {
            // Phase γ.3 — gentle nudge if the user picked the NPU backend
            // without downloading the artifact. `initializeLitertNpuAgent`
            // also handles this state, but surfacing it in
            // checkPrerequisites means we skip the discoverDeviceCapabilities
            // detour when we already know we're going to bail.
            val mgr = LiteRtModelManager(this)
            if (!mgr.isModelDownloaded()) {
                Toast.makeText(
                    this,
                    getString(R.string.litert_npu_error_missing_model),
                    Toast.LENGTH_LONG,
                ).show()
                startActivity(Intent(this, SettingsActivity::class.java))
                return
            }
        } else if (mode == SecureStorage.BACKEND_QWEN_CLOUD) {
            if (!secureStorage.hasQwenApiKey()) {
                Toast.makeText(this, "Enable Power user / BYOM in Settings and set a DashScope API key", Toast.LENGTH_LONG).show()
                startActivity(Intent(this, SettingsActivity::class.java))
                return
            }
        } else {
            if (!secureStorage.hasApiKey()) {
                Toast.makeText(this, "Enable Power user / BYOM in Settings and set an API key", Toast.LENGTH_LONG).show()
                startActivity(Intent(this, SettingsActivity::class.java))
                return
            }
        }

        val service = ThumperAccessibilityService.instance
        if (BuildConfig.GHOLA_DEVICE_CONTROL_ENABLED && service == null) {
            Toast.makeText(this, "Tap Ghola, then turn it on to control apps.", Toast.LENGTH_LONG).show()
            if (!promptedAccessibilityThisSession) {
                promptedAccessibilityThisSession = true
                AccessibilitySetup.open(this)
            }
            return
        }

        initializeAgent(allowWalletApproval)
    }

    private fun signInToCloudThenInitialize() {
        if (isSigningIntoCloud) return
        val walletAddress = secureStorage.getSolanaAddress().orEmpty()
        if (!BuildConfig.GHOLA_PLAY_STORE_BUILD && walletAddress.isBlank()) {
            startActivity(Intent(this, WalletActivity::class.java))
            return
        }

        isSigningIntoCloud = true
        setInputEnabled(false)
        showStatus(if (BuildConfig.GHOLA_PLAY_STORE_BUILD) "Signing in with Turnkey..." else "Signing in with wallet...")
        lifecycleScope.launch {
            val auth = runCatching {
                ApprovalGate.request(
                    context = this@ChatActivity,
                    reason = ApprovalGate.Reason.CONNECT,
                    caller = "ChatActivity.signInToCloud",
                ) {
                    if (BuildConfig.GHOLA_PLAY_STORE_BUILD) {
                        CloudAuthManager(this@ChatActivity).signInWithTurnkey(this@ChatActivity)
                    } else {
                        CloudAuthManager(this@ChatActivity)
                            .signInWithWallet(activityResultSender, walletAddress)
                    }
                }
            }.getOrElse { err ->
                CloudAuthManager.AuthResult.Error(err.message ?: "Sign-in failed")
            }
            isSigningIntoCloud = false
            setInputEnabled(true)
            when (auth) {
                is CloudAuthManager.AuthResult.Success -> {
                    hideStatus()
                    checkPrerequisites(allowWalletApproval = false)
                }
                is CloudAuthManager.AuthResult.Error -> {
                    showStatusAction(auth.message, "Retry") { signInToCloudThenInitialize() }
                    Toast.makeText(this@ChatActivity, auth.message, Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    private fun initializeAgent(allowWalletApproval: Boolean = false) {
        val toolExecutor = if (BuildConfig.GHOLA_DEVICE_CONTROL_ENABLED) {
            val service = ThumperAccessibilityService.instance ?: return
            val commandHandler = service.commandHandler ?: return
            LocalToolExecutor(commandHandler, packageName)
        } else {
            if (BuildConfig.GHOLA_SEEKER_BUILD) {
                secureStorage.setIsSeeker(true)
                secureStorage.setCryptoEnabled(true)
            }
            LocalToolExecutor(null, packageName)
        }

        // Run device detection on background thread, then initialize the agent
        if (BuildConfig.GHOLA_DEVICE_CONTROL_ENABLED && !secureStorage.hasWalletPackage()) {
            showStatus("Discovering device apps...")
            Thread {
                discoverDeviceCapabilities(toolExecutor)
                runOnUiThread {
                    hideStatus()
                    createAgent(toolExecutor, allowWalletApproval)
                }
            }.start()
        } else {
            createAgent(toolExecutor, allowWalletApproval)
        }
    }

    private fun createAgent(toolExecutor: LocalToolExecutor, allowWalletApproval: Boolean = false) {
        // Pre-warm wallet intent cache if crypto is enabled
        secureStorage.getWalletPackage()?.let { pkg ->
            intentCache[pkg] = packageManager.getLaunchIntentForPackage(pkg)
        }

        when {
            activeBackendMode() == SecureStorage.BACKEND_E2E_CLOUD -> initializeE2eAgent(toolExecutor, allowWalletApproval)
            activeBackendMode() == SecureStorage.BACKEND_LOCAL -> initializeLocalAgent(toolExecutor)
            activeBackendMode() == SecureStorage.BACKEND_QWEN_CLOUD -> initializeQwenCloudAgent(toolExecutor)
            activeBackendMode() == SecureStorage.BACKEND_LITERT_NPU ->
                initializeLitertNpuAgent(toolExecutor)
            else -> initializeCloudAgent(toolExecutor)
        }
    }

    /**
     * Phase γ.3 — LiteRT-LM + NeuroPilot Accelerator dispatch. The
     * user picked "On-device NPU (Gemma-3-1B)" in Settings; we have
     * to decide whether the `.litertlm` artifact is healthy enough to
     * stand up [LiteRTNeuroPilotBackend] or whether to fall back /
     * fail loud.
     *
     * Decision tree (mirrors the matrix documented on
     * [LiteRtNpuDispatcher]):
     *  - `VERIFIED` / `DOWNLOADED_UNVERIFIED` → build the NPU backend
     *  - `NOT_DOWNLOADED` → toast + bounce to Settings. Do not silently
     *    downgrade to cloud; the user explicitly chose on-device inference.
     *  - `TAMPERED` → show an error message; do NOT silently
     *    downgrade. The user explicitly chose to keep data on-device;
     *    quietly switching to cloud would leak that data.
     *
     * Runs the integrity check on `Dispatchers.IO` because hashing a
     * 600MB artifact blocks for a few hundred ms on Seeker. The
     * AgentController construction itself stays on the main thread.
     */
    private fun initializeLitertNpuAgent(toolExecutor: LocalToolExecutor) {
        val mgr = LiteRtModelManager(this)
        setInputEnabled(false)
        showStatus("Verifying on-device NPU model…")

        lifecycleScope.launch {
            val (status, modelPath) = withContext(Dispatchers.IO) {
                val s = runCatching { mgr.isModelVerified() }.getOrNull()
                    ?: ModelStatus.NOT_DOWNLOADED
                val p = runCatching { mgr.getModelPath() }.getOrNull()
                s to p
            }
            val decision = LiteRtNpuDispatcher.decide(status, modelPath)
            when (decision) {
                is LiteRtNpuDispatcher.Decision.BuildBackend -> {
                    val backend: LlmBackend = try {
                        LiteRTNeuroPilotBackend(
                            modelFile = java.io.File(decision.modelPath),
                            nativeLibraryDir = applicationInfo.nativeLibraryDir,
                            cacheDir = cacheDir.absolutePath,
                        )
                    } catch (e: Exception) {
                        Log.e(TAG, "LiteRT NPU backend construction failed", e)
                        hideStatus()
                        Toast.makeText(
                            this@ChatActivity,
                            "On-device NPU backend failed to load: ${e.message}",
                            Toast.LENGTH_LONG,
                        ).show()
                        setInputEnabled(true)
                        return@launch
                    }
                    agentController = AgentController(
                        backend, toolExecutor, this@ChatActivity,
                        secureStorage.getWalletPackage(),
                        secureStorage.isSeeker(),
                        secureStorage.hasCloudAuth(),
                        deviceToolsEnabled = BuildConfig.GHOLA_DEVICE_CONTROL_ENABLED,
                    )
                    hideStatus()
                    setInputEnabled(true)
                }
                is LiteRtNpuDispatcher.Decision.FallbackMissingModel -> {
                    Toast.makeText(
                        this@ChatActivity,
                        getString(R.string.litert_npu_error_missing_model),
                        Toast.LENGTH_LONG,
                    ).show()
                    hideStatus()
                    setInputEnabled(true)
                    startActivity(Intent(this@ChatActivity, SettingsActivity::class.java))
                }
                is LiteRtNpuDispatcher.Decision.FailWithTamperedError -> {
                    hideStatus()
                    Toast.makeText(
                        this@ChatActivity,
                        getString(R.string.litert_npu_error_tampered),
                        Toast.LENGTH_LONG,
                    ).show()
                    setInputEnabled(true)
                    startActivity(Intent(this@ChatActivity, SettingsActivity::class.java))
                }
            }
        }
    }

    /**
     * E2E backend setup — Phase 0.3 default for wallet-paired users.
     *
     * Flow:
     *   1. Read the cached Solana address (set by WalletActivity).
     *   2. Construct the user's `did:key:zXXX` from that address.
     *   3. Build a [VaultStore] for that DID.
     *   4. Off-thread, prompt MWA `signMessage` once only after the user
     *      taps the explicit Unlock action
     *      challenge so the vault material is derived.
     *   5. On success → instantiate [EnvelopeCloudBackend] and start
     *      AgentController. On failure → user-friendly toast and bail.
     */
    private fun initializeE2eAgent(toolExecutor: LocalToolExecutor, allowWalletApproval: Boolean = false) {
        val solanaAddress = secureStorage.getSolanaAddress()
        if (solanaAddress.isNullOrBlank()) {
            showStatusAction("No Solana wallet connected.", "Connect") {
                startActivity(Intent(this, WalletActivity::class.java))
            }
            return
        }
        val authToken = secureStorage.getCloudAuthToken()
        if (authToken.isNullOrBlank()) {
            showStatusAction("Sign in to Ghola Cloud.", "Sign in") {
                signInToCloudThenInitialize()
            }
            return
        }

        val pubBytes = try {
            Base58.decode(solanaAddress)
        } catch (e: Exception) {
            Log.e(TAG, "invalid Solana address in storage", e)
            showStatus("Wallet address invalid; reconnect in Wallet")
            return
        }
        if (pubBytes.size != 32) {
            showStatus("Wallet address must be a 32-byte Ed25519 pubkey")
            return
        }
        val userDid = Envelope.didKeyFromVerifying(pubBytes)
        val vault = VaultStoreHolder.get(this, userDid)
        vaultStore = vault

        if (!vault.isUnlocked() && !allowWalletApproval) {
            setInputEnabled(true)
            showStatusAction("Encrypted chat is locked.", "Unlock") {
                initializeAgent(allowWalletApproval = true)
            }
            return
        }

        setInputEnabled(false)
        showStatus(
            if (vault.isUnlocked()) {
                "Opening encrypted chat..."
            } else if (BuildConfig.GHOLA_PLAY_STORE_BUILD) {
                "Approve with Turnkey to unlock end-to-end chat…"
            } else {
                "Tap your wallet to unlock end-to-end chat…"
            },
        )

        lifecycleScope.launch {
            val outcome = runCatching {
                val signer = if (vault.isUnlocked()) {
                    null
                } else {
                    ApprovalGate.request(
                        context = this@ChatActivity,
                        reason = ApprovalGate.Reason.UNLOCK_CHAT,
                        caller = "ChatActivity.initializeE2eAgent",
                    ) {
                        if (BuildConfig.GHOLA_PLAY_STORE_BUILD) {
                            DeviceSignerProvider.cached(this@ChatActivity)
                                ?: DeviceSignerProvider.signIn(this@ChatActivity).getOrThrow()
                            DeviceSignerProvider.cached(this@ChatActivity)?.vaultSigner()
                                ?: error("Turnkey signer unavailable after sign-in")
                        } else {
                            mwaSignerForVault(
                                activityResultSender,
                                solanaAddress,
                                secureStorage.getMwaAuthToken(),
                            )
                        }
                    }
                }
                if (signer != null) {
                    withContext(Dispatchers.IO) { vault.unlock(signer) }
                }
            }
            outcome.onSuccess {
                hideStatus()
                val backend: LlmBackend = EnvelopeCloudBackend(
                    baseUrl = secureStorage.getCloudBaseUrl(),
                    authToken = authToken,
                    vault = vault,
                )
                agentController = AgentController(
                    backend, toolExecutor, this@ChatActivity,
                    secureStorage.getWalletPackage(),
                    secureStorage.isSeeker(),
                    secureStorage.hasCloudAuth(),
                    deviceToolsEnabled = BuildConfig.GHOLA_DEVICE_CONTROL_ENABLED,
                )
                setInputEnabled(true)
            }
            outcome.onFailure { err ->
                Log.w(TAG, "vault unlock failed", err)
                val msg = when (err) {
                    is VaultStore.VaultLockedError.NoWalletPaired ->
                        "Connect a Solana wallet to enable encrypted chat"
                    is VaultStore.VaultLockedError.WalletDeclined ->
                        "Wallet declined — tap Unlock to retry"
                    is VaultStore.VaultLockedError.WalletCancelled ->
                        "Sign request cancelled"
                    is VaultStore.VaultLockedError.DeterminismViolation ->
                        "Wallet returned an unstable signature; chat won't be encrypted"
                    is VaultStore.VaultLockedError ->
                        "Couldn't unlock the encrypted vault"
                    else -> err.message ?: "Couldn't unlock the encrypted vault"
                }
                showStatusAction(msg, "Unlock") {
                    initializeAgent(allowWalletApproval = true)
                }
                setInputEnabled(true)
            }
        }
    }

    private fun initializeCloudAgent(toolExecutor: LocalToolExecutor) {
        val apiKey = secureStorage.getApiKey() ?: return
        val model = secureStorage.getModel()

        val apiClient = ClaudeApiClient(apiKey, model)
        val backend: LlmBackend = CloudLlmBackend(apiClient)
        agentController = AgentController(
            backend, toolExecutor, this,
            secureStorage.getWalletPackage(),
            secureStorage.isSeeker(),
            secureStorage.hasCloudAuth(),
            deviceToolsEnabled = BuildConfig.GHOLA_DEVICE_CONTROL_ENABLED,
        )

        setInputEnabled(true)
    }

    private fun initializeQwenCloudAgent(toolExecutor: LocalToolExecutor) {
        val apiKey = secureStorage.getQwenApiKey() ?: return

        val apiClient = OpenAIApiClient(apiKey, secureStorage.getQwenModel())
        val model = secureStorage.getQwenModel()
        val backend: LlmBackend = CloudLlmBackend(apiClient, "Qwen $model (Cloud)")
        agentController = AgentController(
            backend, toolExecutor, this,
            secureStorage.getWalletPackage(),
            secureStorage.isSeeker(),
            secureStorage.hasCloudAuth(),
            deviceToolsEnabled = BuildConfig.GHOLA_DEVICE_CONTROL_ENABLED,
        )

        setInputEnabled(true)
    }

    private fun initializeLocalAgent(toolExecutor: LocalToolExecutor) {
        val modelManager = ModelManager(this)
        if (!modelManager.isModelDownloaded()) return

        setInputEnabled(false)
        showStatus("Loading Qwen3-4B model...")

        Thread {
            val backend = LocalLlamaBackend()
            val success = backend.loadModel(modelManager.getModelPath())

            runOnUiThread {
                if (success) {
                    localBackend = backend
                    agentController = AgentController(
                        backend, toolExecutor, this,
                        secureStorage.getWalletPackage(),
                        secureStorage.isSeeker(),
                        secureStorage.hasCloudAuth(),
                        deviceToolsEnabled = BuildConfig.GHOLA_DEVICE_CONTROL_ENABLED,
                    )
                    hideStatus()
                    setInputEnabled(true)
                } else {
                    showStatus("Failed to load model")
                    Toast.makeText(this, "Failed to load on-device model", Toast.LENGTH_LONG).show()
                }
            }
        }.start()
    }

    /**
     * Discovers device capabilities: detects Seeker device, finds wallet packages.
     * On Seeker: crypto is enabled by default.
     * On other Android: crypto remains opt-in (user enables in settings).
     */
    private fun discoverDeviceCapabilities(toolExecutor: LocalToolExecutor) {
        try {
            val result = toolExecutor.execute("list_apps", JSONObject())
            if (!result.success) {
                Log.w(TAG, "list_apps failed during device discovery")
                return
            }

            val text = result.content.filterIsInstance<xyz.ghola.app.ai.ContentBlock.Text>()
                .firstOrNull()?.text ?: return

            val apps = try {
                val json = JSONObject(text)
                json.optJSONArray("apps") ?: JSONArray(text)
            } catch (e: Exception) {
                try { JSONArray(text) } catch (e2: Exception) {
                    Log.w(TAG, "Could not parse app list for device discovery")
                    return
                }
            }

            val installedPackages = mutableSetOf<String>()
            val packageToLabel = mutableMapOf<String, String>()
            for (i in 0 until apps.length()) {
                val app = apps.optJSONObject(i) ?: continue
                val pkg = app.optString("package", app.optString("package_name", ""))
                val label = app.optString("label", app.optString("name", ""))
                if (pkg.isNotEmpty()) {
                    installedPackages.add(pkg)
                    if (label.isNotEmpty()) packageToLabel[pkg] = label
                }
            }

            // Detect Seeker device by presence of Seeker-specific packages
            val isSeeker = SEEKER_INDICATOR_PACKAGES.any { it in installedPackages }
            secureStorage.setIsSeeker(isSeeker)
            if (isSeeker) {
                Log.i(TAG, "Detected Solana Seeker device — enabling crypto features")
                secureStorage.setCryptoEnabled(true)
            }

            // Discover wallet package
            // Check candidates in priority order
            for (candidate in WALLET_CANDIDATES) {
                if (candidate in installedPackages) {
                    Log.i(TAG, "Wallet discovered by package match: $candidate")
                    secureStorage.setWalletPackage(candidate)
                    return
                }
            }

            // Match by label keywords (only Solana-related)
            for ((pkg, label) in packageToLabel) {
                val lowerLabel = label.lowercase()
                if (WALLET_LABEL_KEYWORDS.any { it in lowerLabel }) {
                    if ("solana" in lowerLabel || "solflare" in lowerLabel ||
                        "seed" in lowerLabel || pkg.contains("solanamobile")) {
                        Log.i(TAG, "Wallet discovered by label match: $pkg ($label)")
                        secureStorage.setWalletPackage(pkg)
                        return
                    }
                }
            }

            // Any solanamobile package
            for (pkg in installedPackages) {
                if (pkg.contains("solanamobile")) {
                    Log.i(TAG, "Wallet discovered by solanamobile prefix: $pkg")
                    secureStorage.setWalletPackage(pkg)
                    return
                }
            }

            Log.i(TAG, "No Solana wallet package found on device (isSeeker=$isSeeker)")
        } catch (e: Exception) {
            Log.w(TAG, "Device discovery failed", e)
        }
    }

    private fun sendMessage() {
        val text = messageInput.text.toString().trim()
        if (text.isEmpty()) return

        val controller = agentController
        if (controller == null) {
            Toast.makeText(this, "Agent not ready. Check Settings.", Toast.LENGTH_SHORT).show()
            return
        }

        messageInput.text.clear()
        chatAdapter.addMessage(ChatMessage.UserMessage(text))

        if (handleCloudTaskRouting(text)) {
            return
        }

        // Ultra-fast path: handle directly on UI thread, zero pipeline overhead
        val fastMatch = controller.matchFastPath(text)
        Log.d(TAG, "sendMessage: text='$text' fastMatch=${fastMatch?.toolName ?: "null"}")
        if (fastMatch != null && handleDirectly(fastMatch)) {
            Log.d(TAG, "sendMessage: handled directly → ${fastMatch.toolName}")
            return  // Done — never touches executor, tool pipeline, or LLM
        }

        // Normal path (screenshot, read_screen, tap, scroll, swipe, or LLM)
        setInputEnabled(false)
        currentStreamingText = StringBuilder()
        if (fastMatch != null) {
            Log.d(TAG, "sendMessage: fast-path via executor → ${fastMatch.toolName}")
            showStatus(fastMatch.description)
        } else {
            Log.d(TAG, "sendMessage: no fast match → LLM")
            showStatus("Thinking...")
        }

        controller.sendMessage(text)
    }

    private fun handleCloudTaskRouting(text: String): Boolean {
        if (activeBackendMode() == SecureStorage.BACKEND_E2E_CLOUD) return false
        if (!secureStorage.hasCloudAuth()) return false
        val token = secureStorage.getCloudAuthToken() ?: return false
        val route = TaskClassifier.classify(text, true).route
        if (route == TaskClassifier.TaskRoute.CHAT) return false

        val client = ThumperCloudClient(secureStorage.getCloudBaseUrl(), token)
        setInputEnabled(false)
        showStatus("Routing to Ghola Cloud…")

        Thread {
            val responseText = when (route) {
                TaskClassifier.TaskRoute.CLOUD_CALL -> {
                    val number = Regex("""\+?[0-9][0-9\-\s()]{6,}""")
                        .find(text)
                        ?.value
                        ?.replace(Regex("""[^\d+]"""), "")
                    if (number.isNullOrBlank()) {
                        "Add a phone number so I can place the call through Ghola Cloud."
                    } else {
                        val call = client.initiateCall(number, text)
                        if (call != null) {
                            "Call started through Ghola Cloud."
                        } else {
                            "Call request failed. Please try again."
                        }
                    }
                }
                TaskClassifier.TaskRoute.CLOUD_EMAIL -> {
                    val to = Regex("""[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}""")
                        .find(text)
                        ?.value
                    if (to != null) {
                        val draft = client.createEmailDraft(
                            toAddress = to,
                            subject = "Draft from Ghola",
                            bodyText = text
                        )
                        if (draft != null) "Email draft created in Ghola Cloud." else "Email draft failed."
                    } else {
                        val generated = client.generateEmail(text)
                        if (generated != null) "Email draft generated in Ghola Cloud." else "Email generation failed."
                    }
                }
                TaskClassifier.TaskRoute.CLOUD_CALENDAR,
                TaskClassifier.TaskRoute.DEVICE -> {
                    val plan = client.planDeviceAction(text)
                    plan?.optString("plan")?.takeIf { it.isNotBlank() }
                        ?: "Planning request sent to Ghola Cloud, but no plan was returned."
                }
                TaskClassifier.TaskRoute.CHAT -> ""
            }

            runOnUiThread {
                hideStatus()
                setInputEnabled(true)
                if (responseText.isNotBlank()) {
                    chatAdapter.addMessage(ChatMessage.AssistantMessage(responseText, false))
                }
            }
        }.start()
        return true
    }

    /**
     * Handles fast-path commands directly on the UI thread without going through
     * the AgentController/executor/tool pipeline. Returns true if handled.
     */
    private fun handleDirectly(match: FastMatch): Boolean {
        val service = ThumperAccessibilityService.instance
        when (match.toolName) {
            "press_back" -> {
                service?.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
                chatAdapter.addMessage(ChatMessage.AssistantMessage(match.description, false))
                return true
            }
            "global_action" -> {
                val action = match.input.optString("action")
                val globalAction = when (action) {
                    "home" -> android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_HOME
                    "recents" -> android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_RECENTS
                    "notifications" -> android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS
                    else -> return false
                }
                service?.performGlobalAction(globalAction)
                chatAdapter.addMessage(ChatMessage.AssistantMessage(match.description, false))
                return true
            }
            else -> return false  // read_screen, screenshot → still need tool pipeline
        }
    }

    private fun setInputEnabled(enabled: Boolean) {
        sendButton.isEnabled = enabled
        sendButton.alpha = if (enabled) 1.0f else 0.4f
    }

    private fun showStatus(text: String) {
        statusAction = null
        statusBar.text = text
        statusActionButton.visibility = View.GONE
        statusPanel.visibility = View.VISIBLE
    }

    private fun showStatusAction(text: String, actionText: String, action: () -> Unit) {
        statusAction = action
        statusBar.text = text
        statusActionButton.text = actionText
        statusActionButton.visibility = View.VISIBLE
        statusPanel.visibility = View.VISIBLE
    }

    private fun hideStatus() {
        statusAction = null
        statusActionButton.visibility = View.GONE
        statusPanel.visibility = View.GONE
    }

    // AgentListener implementation

    override fun onAssistantText(text: String, isFinal: Boolean) {
        if (currentStreamingText.isEmpty()) {
            currentStreamingText.append(text)
            chatAdapter.addMessage(ChatMessage.AssistantMessage(currentStreamingText.toString(), !isFinal))
        } else {
            currentStreamingText.append(text)
            chatAdapter.updateLastAssistantText(currentStreamingText.toString())
        }

        if (isFinal) {
            currentStreamingText = StringBuilder()
        }
    }

    override fun onToolCallStart(name: String, input: JSONObject) {
        lastToolWasExplicitScreenshot = (name == "screenshot")
        showStatus(ToolFriendlyNames.describe(name, input))
    }

    override fun onToolCallComplete(name: String, summary: String) {
        // Status bar holds last tool description until onThinking() fires
    }

    override fun onScreenshot(base64: String) {
        if (lastToolWasExplicitScreenshot) {
            chatAdapter.addMessage(ChatMessage.Screenshot(base64))
        } else {
            pendingScreenshot = base64
        }
    }

    override fun onThinking() {
        showStatus("Thinking...")
    }

    override fun onError(message: String) {
        chatAdapter.addMessage(ChatMessage.ErrorMessage(message))
        pendingScreenshot = null
        hideStatus()
        setInputEnabled(true)
    }

    override fun onConversationComplete() {
        pendingScreenshot?.let { base64 ->
            chatAdapter.addMessage(ChatMessage.Screenshot(base64))
            pendingScreenshot = null
        }
        hideStatus()
        setInputEnabled(true)
        currentStreamingText = StringBuilder()
    }
}
