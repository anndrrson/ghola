package xyz.ghola.app.network

import android.util.Log
import okhttp3.*
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/**
 * WebSocket client that connects to the thumper-relay server.
 * Handles authentication, command routing, and auto-reconnection
 * with exponential backoff and single-flight reconnect guard.
 */
class RelayConnection(
    private val relayUrl: String,
    private val devicePubkey: String,
    private val commandHandler: CommandHandler
) {

    companion object {
        private const val TAG = "ThumperRelay"
        private const val BASE_DELAY_MS = 2000L
        private const val MAX_DELAY_MS = 60000L
    }

    private enum class AuthState { PENDING_AUTH, READY }

    private val authState = AtomicReference(AuthState.PENDING_AUTH)
    private val connected = AtomicBoolean(false)
    private val shouldReconnect = AtomicBoolean(false)
    private val reconnecting = AtomicBoolean(false)
    private val consecutiveFailures = AtomicInteger(0)

    @Volatile
    private var webSocket: WebSocket? = null

    // No pingInterval — relay handles keepalive pings.
    // Read timeout 0 = infinite (WebSocket is long-lived).
    private val client = OkHttpClient.Builder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    fun connect() {
        shouldReconnect.set(true)
        consecutiveFailures.set(0)
        doConnect()
    }

    fun disconnect() {
        shouldReconnect.set(false)
        connected.set(false)
        webSocket?.close(1000, "client disconnect")
        webSocket = null
    }

    fun isConnected(): Boolean = connected.get()

    private fun doConnect() {
        // Single-flight guard: only one connect attempt at a time.
        if (!reconnecting.compareAndSet(false, true)) {
            Log.d(TAG, "Connect already in progress, skipping")
            return
        }

        authState.set(AuthState.PENDING_AUTH)

        val request = Request.Builder()
            .url(relayUrl)
            .build()

        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                Log.i(TAG, "WebSocket opened, sending auth")
                reconnecting.set(false)
                sendAuth(webSocket)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                handleMessage(webSocket, text)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                Log.i(TAG, "WebSocket closing: $code $reason")
                webSocket.close(1000, null)
                onDisconnected()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.e(TAG, "WebSocket failure: ${t.message}")
                reconnecting.set(false)
                onDisconnected()
            }
        })
    }

    private fun onDisconnected() {
        val wasConnected = connected.getAndSet(false)
        if (wasConnected) {
            // Reset failure counter on first disconnect after a successful session
            consecutiveFailures.set(0)
        }
        scheduleReconnect()
    }

    private fun sendAuth(webSocket: WebSocket) {
        val auth = JSONObject().apply {
            put("message", JSONObject().apply {
                put("pubkey", devicePubkey)
                put("timestamp", System.currentTimeMillis() / 1000)
                put("nonce", UUID.randomUUID().toString())
                put("role", "device")
            })
            put("signature", "") // Empty in dev mode
        }

        authState.set(AuthState.PENDING_AUTH)
        webSocket.send(auth.toString())
    }

    private fun handleMessage(ws: WebSocket, text: String) {
        try {
            val json = JSONObject(text)

            when (authState.get()) {
                AuthState.PENDING_AUTH -> {
                    if (json.optBoolean("authenticated", false)) {
                        Log.i(TAG, "Authentication successful")
                        authState.set(AuthState.READY)
                        connected.set(true)
                        consecutiveFailures.set(0)
                    } else if (json.has("error")) {
                        Log.e(TAG, "Auth failed: ${json.getString("error")}")
                        connected.set(false)
                    }
                }
                AuthState.READY -> {
                    commandHandler.handleCommand(text) { response ->
                        if (connected.get()) {
                            ws.send(response)
                        }
                    }
                }
                else -> {}
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error handling message", e)
        }
    }

    private fun scheduleReconnect() {
        if (!shouldReconnect.get()) return

        val failures = consecutiveFailures.incrementAndGet()
        val delay = (BASE_DELAY_MS * (1L shl (failures - 1).coerceAtMost(5))).coerceAtMost(MAX_DELAY_MS)
        Log.i(TAG, "Reconnecting in ${delay}ms (attempt $failures)")

        Thread {
            Thread.sleep(delay)
            if (shouldReconnect.get()) {
                doConnect()
            }
        }.start()
    }
}
