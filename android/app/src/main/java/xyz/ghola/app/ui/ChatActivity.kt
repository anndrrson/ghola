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
import com.solana.mobilewalletadapter.clientlib.ActivityResultSender
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
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
import xyz.ghola.app.ai.SecureStorage
import xyz.ghola.app.ai.ToolFriendlyNames
import xyz.ghola.app.ai.llama.LocalLlamaBackend
import xyz.ghola.app.ai.llama.ModelManager
import xyz.ghola.app.cloud.CloudAuthManager
import xyz.ghola.app.cloud.TaskClassifier
import xyz.ghola.app.cloud.ThumperCloudClient
import xyz.ghola.app.crypto.Envelope
import xyz.ghola.app.crypto.VaultStore
import xyz.ghola.app.crypto.mwaSignerForVault
import xyz.ghola.app.service.ThumperAccessibilityService
import xyz.ghola.app.solana.Base58

class ChatActivity : AppCompatActivity(), AgentListener {

    companion object {
        private const val TAG = "ChatActivity"

        // Wallet package candidates in priority order (Seeker + general crypto)
        private val WALLET_CANDIDATES = listOf(
            "com.solflare.mobile",
            "com.solanamobile.seedvault",
            "com.solanamobile.seedvaultimpl",
            "app.phantom"
        )

        // Keywords in app labels that indicate a Solana wallet
        private val WALLET_LABEL_KEYWORDS = listOf(
            "seed vault", "seedvault", "solflare", "wallet"
        )

        // Packages that indicate this is a Solana Seeker device
        private val SEEKER_INDICATOR_PACKAGES = listOf(
            "com.solanamobile.seedvault",
            "com.solanamobile.seedvaultimpl",
            "com.solanamobile.dappstore"
        )
    }

    private lateinit var secureStorage: SecureStorage
    private lateinit var chatRecyclerView: RecyclerView
    private lateinit var messageInput: EditText
    private lateinit var sendButton: ImageButton
    private lateinit var statusBar: TextView
    private lateinit var chatAdapter: ChatAdapter

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
    private var quickActionHandled = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_chat)

        // The chat header is now a plain ConstraintLayout band (eyebrow +
        // accent bar + title) styled to match the home grid. The overflow
        // button at @id/toolbarOverflow opens a PopupMenu inflated from
        // R.menu.chat_menu — replaces the AppCompat Toolbar's action menu.
        findViewById<android.widget.ImageButton>(R.id.toolbarOverflow).setOnClickListener { anchor ->
            val popup = android.widget.PopupMenu(this, anchor)
            popup.menuInflater.inflate(R.menu.chat_menu, popup.menu)
            popup.setOnMenuItemClickListener { item ->
                onOptionsItemSelected(item)
            }
            popup.show()
        }

        secureStorage = SecureStorage(this)

        chatRecyclerView = findViewById(R.id.chatRecyclerView)
        messageInput = findViewById(R.id.messageInput)
        sendButton = findViewById(R.id.sendButton)
        statusBar = findViewById(R.id.statusBar)

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

        // Handle prefill from HomeActivity voice input or quick actions
        intent.getStringExtra("prefill_message")?.let { prefill ->
            messageInput.setText(prefill)
            if (intent.getBooleanExtra("auto_send", false)) {
                val forced = intent.getStringExtra("force_cloud_route")
                if (forced == "call" || forced == "email" || forced == "calendar") {
                    messageInput.post { executeForcedQuickAction(prefill, forced) }
                } else {
                    // Auto-send once initialization is ready, with bounded retries.
                    scheduleAutoSend(attempt = 0)
                }
            }
        }
    }

    private fun executeForcedQuickAction(text: String, forced: String) {
        if (quickActionHandled) return
        quickActionHandled = true

        val route = when (forced) {
            "call" -> TaskClassifier.TaskRoute.CLOUD_CALL
            "email" -> TaskClassifier.TaskRoute.CLOUD_EMAIL
            "calendar" -> TaskClassifier.TaskRoute.CLOUD_CALENDAR
            else -> null
        }
        if (route == null) return

        chatAdapter.addMessage(ChatMessage.UserMessage(text))
        messageInput.text.clear()
        val routed = handleCloudTaskRouting(text, route)
        if (!routed) {
            chatAdapter.addMessage(
                ChatMessage.AssistantMessage(
                    "Cloud session missing. Reconnect your wallet in onboarding.",
                    false
                )
            )
        }
    }

    private fun scheduleAutoSend(attempt: Int) {
        val text = messageInput.text.toString().trim()
        if (text.isEmpty()) return
        val route = TaskClassifier.classify(text, secureStorage.hasCloudAuth()).route
        val cloudRouted = route == TaskClassifier.TaskRoute.CLOUD_CALL ||
            route == TaskClassifier.TaskRoute.CLOUD_EMAIL ||
            route == TaskClassifier.TaskRoute.CLOUD_CALENDAR

        if (agentController != null || cloudRouted) {
            sendMessage()
            return
        }
        if (attempt >= 12) return
        messageInput.postDelayed({ scheduleAutoSend(attempt + 1) }, 250)
    }

    override fun onResume() {
        super.onResume()
        checkPrerequisites()
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
        // Preserve conversation memory across short app switches so the
        // assistant remains stateful and less repetitive.
    }

    override fun onDestroy() {
        super.onDestroy()
        agentController?.shutdown()
        localBackend?.shutdown()
        // Vault is process-cached via VaultStoreHolder — do NOT lock on every
        // activity destroy. The vault's own idle TTL (DEFAULT_IDLE_TTL_MILLIS,
        // 15 min) handles auto-lock when the user is genuinely away. Locking
        // here forced a wallet re-prompt on every chat re-entry.
    }

    private fun checkPrerequisites() {
        if (secureStorage.isE2ECloudMode()) {
            if (!secureStorage.hasSolanaAddress()) {
                Toast.makeText(
                    this,
                    "Connect a Solana wallet first to enable end-to-end encrypted chat",
                    Toast.LENGTH_LONG,
                ).show()
                startActivity(Intent(this, WalletActivity::class.java))
                return
            }
            // NOTE: we used to auto-trigger SIWS sign-in here when hasCloudAuth()
            // was false. That created a "wallet prompt on every chat resume"
            // cascade — the most-reported user pain in v0.4.0 Seeker testing.
            //
            // Interactive SIWS is now reserved for:
            //   1. The OnboardingActivity sign-in CTA.
            //   2. The 401-after-refresh path in cloud clients (which routes
            //      the user back to onboarding via HomeActivity.requireCloudAuthOrBounce).
            // Proactive token refresh runs from AppForegroundCoordinator on
            // app-foreground events. ChatActivity itself never prompts.
            //
            // If we reach here without cloud auth in E2E mode, we surface a
            // hint and let the user navigate to onboarding themselves.
            if (!secureStorage.hasCloudAuth()) {
                showStatus("Wallet sign-in expired — reconnect from the home screen")
                return
            }
        } else if (secureStorage.isLocalMode()) {
            val modelManager = ModelManager(this)
            if (!modelManager.isModelDownloaded()) {
                Toast.makeText(this, "Please download the model in Settings", Toast.LENGTH_LONG).show()
                startActivity(Intent(this, SettingsActivity::class.java))
                return
            }
        } else if (secureStorage.isQwenCloudMode()) {
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

        if (agentController == null) {
            initializeAgent()
        } else {
            hideStatus()
            setInputEnabled(true)
        }
    }

    private fun initializeAgent() {
        val commandHandler = ThumperAccessibilityService.instance?.commandHandler
        val toolExecutor = LocalToolExecutor(commandHandler, packageName)

        // Run device detection on background thread, then initialize the agent
        if (commandHandler != null && !secureStorage.hasWalletPackage()) {
            showStatus("Discovering device apps...")
            Thread {
                discoverDeviceCapabilities(toolExecutor)
                runOnUiThread {
                    hideStatus()
                    createAgent(toolExecutor)
                }
            }.start()
        } else {
            if (commandHandler == null) {
                showStatus("Accessibility off: device tools disabled (chat/calls still work)")
            }
            createAgent(toolExecutor)
        }
    }

    private fun createAgent(toolExecutor: LocalToolExecutor) {
        // Pre-warm wallet intent cache if crypto is enabled
        secureStorage.getWalletPackage()?.let { pkg ->
            intentCache[pkg] = packageManager.getLaunchIntentForPackage(pkg)
        }

        when {
            secureStorage.isE2ECloudMode() -> initializeE2eAgent(toolExecutor)
            secureStorage.isLocalMode() -> initializeLocalAgent(toolExecutor)
            secureStorage.isQwenCloudMode() -> initializeQwenCloudAgent(toolExecutor)
            else -> initializeCloudAgent(toolExecutor)
        }
    }

    /**
     * E2E backend setup — Phase 0.3 default for wallet-paired users.
     *
     * Flow:
     *   1. Read the cached Solana address (set by WalletActivity).
     *   2. Construct the user's `did:key:zXXX` from that address.
     *   3. Build a [VaultStore] for that DID.
     *   4. Off-thread, prompt MWA `signMessage` once on the unlock
     *      challenge so the vault material is derived.
     *   5. On success → instantiate [EnvelopeCloudBackend] and start
     *      AgentController. On failure → user-friendly toast and bail.
     */
    private fun initializeE2eAgent(toolExecutor: LocalToolExecutor) {
        val solanaAddress = secureStorage.getSolanaAddress()
        if (solanaAddress.isNullOrBlank()) {
            showStatus("No Solana wallet connected")
            startActivity(Intent(this, WalletActivity::class.java))
            return
        }
        val authToken = secureStorage.getCloudAuthToken()
        if (authToken.isNullOrBlank()) {
            showStatus("Sign in to Ghola Cloud")
            startActivity(Intent(this, SettingsActivity::class.java))
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
        // Process-wide cache: if the vault is already unlocked (from a
        // previous chat session within the idle TTL), reuse it and skip the
        // MWA prompt entirely. This is the fix for "wallet pops up on every
        // tile tap" reported on Seeker.
        val vault = xyz.ghola.app.crypto.VaultStoreHolder.get(this, userDid)
        vaultStore = vault

        if (vault.isUnlocked()) {
            // Hot path: vault already keyed. Wire the backend without
            // touching the wallet.
            hideStatus()
            val backend: LlmBackend = EnvelopeCloudBackend(
                baseUrl = secureStorage.getCloudBaseUrl(),
                authToken = authToken,
                vault = vault,
            )
            agentController = AgentController(
                backend, toolExecutor, this,
                secureStorage.getWalletPackage(),
                secureStorage.isSeeker(),
                secureStorage.hasCloudAuth(),
            )
            setInputEnabled(true)
            return
        }

        setInputEnabled(false)
        showStatus("Tap your wallet to unlock end-to-end chat…")

        lifecycleScope.launch {
            val outcome = runCatching {
                val signer = mwaSignerForVault(activityResultSender, solanaAddress)
                withContext(Dispatchers.IO) { vault.unlock(signer) }
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
                )
                setInputEnabled(true)
            }
            outcome.onFailure { err ->
                Log.w(TAG, "vault unlock failed", err)
                val msg = when (err) {
                    is VaultStore.VaultLockedError.NoWalletPaired ->
                        "Connect a Solana wallet to enable encrypted chat"
                    is VaultStore.VaultLockedError.WalletDeclined ->
                        "Wallet declined — tap Send again to retry"
                    is VaultStore.VaultLockedError.WalletCancelled ->
                        "Sign request cancelled"
                    is VaultStore.VaultLockedError.DeterminismViolation ->
                        "Wallet returned an unstable signature; chat won't be encrypted"
                    is VaultStore.VaultLockedError ->
                        "Couldn't unlock the encrypted vault"
                    else -> err.message ?: "Couldn't unlock the encrypted vault"
                }
                showStatus(msg)
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
            secureStorage.hasCloudAuth()
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
            secureStorage.hasCloudAuth()
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
                        secureStorage.hasCloudAuth()
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

        messageInput.text.clear()
        chatAdapter.addMessage(ChatMessage.UserMessage(text))

        if (handleCloudTaskRouting(text, null)) {
            return
        }

        val controller = agentController
        if (controller == null) {
            Toast.makeText(this, "Agent is still initializing. Try again in a moment.", Toast.LENGTH_SHORT).show()
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

    private fun handleCloudTaskRouting(
        text: String,
        forcedRoute: TaskClassifier.TaskRoute?
    ): Boolean {
        if (!secureStorage.hasCloudAuth()) return false
        val token = secureStorage.getCloudAuthToken() ?: return false
        val route = forcedRoute ?: TaskClassifier.classify(text, true).route
        if (route != TaskClassifier.TaskRoute.CLOUD_CALL &&
            route != TaskClassifier.TaskRoute.CLOUD_EMAIL &&
            route != TaskClassifier.TaskRoute.CLOUD_CALENDAR
        ) {
            return false
        }

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
                        formatCallForChat(call, number, text)
                    }
                }
                TaskClassifier.TaskRoute.CLOUD_EMAIL -> {
                    val to = Regex("""[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}""")
                        .find(text)
                        ?.value
                    val draft = if (to != null) {
                        client.createEmailDraft(
                            toAddress = to,
                            subject = "Draft from Ghola",
                            bodyText = text,
                        )
                    } else {
                        client.generateEmail(text)
                    }
                    formatEmailDraftForChat(draft)
                }
                TaskClassifier.TaskRoute.CLOUD_CALENDAR -> {
                    val plan = client.planDeviceAction(text)
                    plan?.optString("plan")?.takeIf { it.isNotBlank() }
                        ?: "Planning request sent to Ghola Cloud, but no plan was returned."
                }
                TaskClassifier.TaskRoute.DEVICE,
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
     * Render the actual email draft returned by /api/emails/generate (or
     * /api/emails/draft) as a readable assistant message. Previously the user
     * saw only "Email draft generated in Ghola Cloud." while the To / Subject
     * / Body were quietly persisted in the cloud DB with no way for the user
     * to see them — a confusing dead-end that read as "where tf was it
     * generated?". The full draft text is now rendered inline so the user
     * can review and decide whether to ship it (the actual send action lives
     * in the web ActionCard surface; Android sees the draft + an explainer).
     */
    private fun formatEmailDraftForChat(draft: org.json.JSONObject?): String {
        if (draft == null) return "Email generation failed. Please try again."
        val to = draft.optString("to_address", "").ifBlank { "(no recipient)" }
        val subject = draft.optString("subject", "").ifBlank { "(no subject)" }
        val body = draft.optString("body", "").ifBlank { "(empty body)" }
        return buildString {
            append("Drafted an email for you. Review below and send from the inbox at ghola.xyz.\n\n")
            append("To: ").append(to).append('\n')
            append("Subject: ").append(subject).append("\n\n")
            append(body)
        }
    }

    /**
     * Render the cloud-call response so the user sees a confirmation, the
     * dialed number, and the call id (used by support / retries). Previously
     * collapsed to "Call started through Ghola Cloud." which hid useful state.
     */
    private fun formatCallForChat(
        response: org.json.JSONObject?,
        number: String,
        objective: String,
    ): String {
        if (response == null) return "Call request failed. Please try again."
        val callId = response.optString("id", "").ifBlank { response.optString("call_id", "") }
        val status = response.optString("status", "queued")
        return buildString {
            append("Calling ").append(number).append(" through Ghola Cloud.")
            if (objective.isNotBlank()) append("\nObjective: ").append(objective)
            append("\nStatus: ").append(status)
            if (callId.isNotBlank()) append("\nCall id: ").append(callId)
        }
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
        statusBar.text = text
        statusBar.visibility = View.VISIBLE
    }

    private fun hideStatus() {
        statusBar.visibility = View.GONE
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
