package xyz.orni.thumper.network

import android.util.Log
import okhttp3.*
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * WebSocket client that connects to the thumper-relay server.
 * Handles authentication, command routing, and auto-reconnection.
 */
class RelayConnection(
    private val relayUrl: String,
    private val devicePubkey: String,
    private val commandHandler: CommandHandler
) {

    companion object {
        private const val TAG = "ThumperRelay"
        private const val RECONNECT_DELAY_MS = 5000L
    }

    private var webSocket: WebSocket? = null
    @Volatile
    private var connected = false
    private var shouldReconnect = true

    private val client = OkHttpClient.Builder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(30, TimeUnit.SECONDS)
        .build()

    fun connect() {
        shouldReconnect = true
        doConnect()
    }

    fun disconnect() {
        shouldReconnect = false
        webSocket?.close(1000, "client disconnect")
        webSocket = null
        connected = false
    }

    fun isConnected(): Boolean = connected

    private fun doConnect() {
        val request = Request.Builder()
            .url(relayUrl)
            .build()

        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                Log.i(TAG, "WebSocket opened, sending auth")
                sendAuth(webSocket)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                handleMessage(webSocket, text)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                Log.i(TAG, "WebSocket closing: $code $reason")
                webSocket.close(1000, null)
                connected = false
                scheduleReconnect()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.e(TAG, "WebSocket failure: ${t.message}")
                connected = false
                scheduleReconnect()
            }
        })
    }

    private var authState = AuthState.PENDING_AUTH

    private enum class AuthState {
        PENDING_AUTH,
        READY
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

        authState = AuthState.PENDING_AUTH
        webSocket.send(auth.toString())
    }

    private fun handleMessage(ws: WebSocket, text: String) {
        try {
            val json = JSONObject(text)

            when (authState) {
                AuthState.PENDING_AUTH -> {
                    if (json.optBoolean("authenticated", false)) {
                        Log.i(TAG, "Authentication successful")
                        authState = AuthState.READY
                        connected = true
                    } else if (json.has("error")) {
                        Log.e(TAG, "Auth failed: ${json.getString("error")}")
                        connected = false
                    }
                }
                AuthState.READY -> {
                    // Process command on worker thread, send response when done
                    commandHandler.handleCommand(text) { response ->
                        if (connected) {
                            ws.send(response)
                        }
                    }
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error handling message", e)
        }
    }

    private fun scheduleReconnect() {
        if (!shouldReconnect) return
        Log.i(TAG, "Scheduling reconnect in ${RECONNECT_DELAY_MS}ms")
        Thread {
            Thread.sleep(RECONNECT_DELAY_MS)
            if (shouldReconnect) {
                Log.i(TAG, "Attempting reconnect")
                doConnect()
            }
        }.start()
    }
}
