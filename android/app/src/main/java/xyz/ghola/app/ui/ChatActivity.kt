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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_chat)

        val toolbar = findViewById<Toolbar>(R.id.toolbar)
        setSupportActionBar(toolbar)

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
                // Auto-send after agent is initialized (delayed to allow setup)
                messageInput.post {
                    messageInput.postDelayed({
                        if (agentController != null && messageInput.text.isNotEmpty()) {
                            sendMessage()
                        }
                    }, 500)
                }
            }
        }
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
        // Clear conversation history when user leaves the app so a fresh
        // session starts on return (prevents stale context issues).
        agentController?.clearHistory()
        // Lock the E2E vault when backgrounded so a stolen device that's
        // already unlocked-once can't read on-disk session DEKs without
        // a fresh wallet sign. Re-prompts on the next chat send.
        vaultStore?.lock()
    }

    override fun onDestroy() {
        super.onDestroy()
        agentController?.shutdown()
        localBackend?.shutdown()
        vaultStore?.lock()
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
            if (!secureStorage.hasCloudAuth()) {
                if (isSigningIntoCloud) return
                val walletAddress = secureStorage.getSolanaAddress().orEmpty()
                if (walletAddress.isBlank()) {
                    startActivity(Intent(this, WalletActivity::class.java))
                    return
                }
                isSigningIntoCloud = true
                showStatus("Signing in with wallet…")
                lifecycleScope.launch {
                    val auth = CloudAuthManager(this@ChatActivity)
                        .signInWithWallet(activityResultSender, walletAddress)
                    isSigningIntoCloud = false
                    when (auth) {
                        is CloudAuthManager.AuthResult.Success -> {
                            hideStatus()
                            checkPrerequisites()
                        }
                        is CloudAuthManager.AuthResult.Error -> {
                            showStatus(auth.message)
                            Toast.makeText(this@ChatActivity, auth.message, Toast.LENGTH_LONG).show()
                        }
                    }
                }
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

        val service = ThumperAccessibilityService.instance
        if (service == null) {
            Toast.makeText(this, "Please enable the Accessibility Service in Settings", Toast.LENGTH_LONG).show()
            return
        }

        initializeAgent()
    }

    private fun initializeAgent() {
        val service = ThumperAccessibilityService.instance ?: return
        val commandHandler = service.commandHandler ?: return
        val toolExecutor = LocalToolExecutor(commandHandler, packageName)

        // Run device detection on background thread, then initialize the agent
        if (!secureStorage.hasWalletPackage()) {
            showStatus("Discovering device apps...")
            Thread {
                discoverDeviceCapabilities(toolExecutor)
                runOnUiThread {
                    hideStatus()
                    createAgent(toolExecutor)
                }
            }.start()
        } else {
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
        val vault = VaultStore.create(this, userDid)
        vaultStore = vault

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
