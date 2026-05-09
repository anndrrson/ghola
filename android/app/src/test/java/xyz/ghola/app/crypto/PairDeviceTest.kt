package xyz.ghola.app.crypto

import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Before
import org.junit.BeforeClass
import org.junit.Test
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.LinkedBlockingDeque
import java.util.concurrent.TimeUnit

/**
 * End-to-end exercise of the Pair Device flow against MockWebServer.
 *
 * The test stands up a fake `/api/devices/handshake` mailbox: POSTs from
 * the sender are queued; subsequent GETs from the receiver pop them. The
 * crypto path is real (Envelope.seal / open / signature verification),
 * so any wire-format drift fails here as well as in [ParityVectorsTest].
 */
class PairDeviceTest {

    companion object {
        @JvmStatic
        @BeforeClass
        fun setUp() {
            CryptoProviders.installBouncyCastleOnce()
        }
    }

    private val rng = SecureRandom()
    private lateinit var server: MockWebServer
    private val mailbox = LinkedBlockingDeque<ByteArray>()

    @Before fun startServer() {
        server = MockWebServer()
        mailbox.clear()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(req: RecordedRequest): MockResponse {
                val path = req.path ?: ""
                return when {
                    req.method == "POST" && path == "/api/devices/handshake" -> {
                        val body = req.body.readUtf8()
                        val obj = JSONObject(body)
                        val envelope = Base64.getUrlDecoder().decode(obj.getString("envelope_b64"))
                        mailbox.add(envelope)
                        MockResponse().setResponseCode(200).setBody("""{"ok":true,"expires_at_ms":0}""")
                    }
                    req.method == "GET" && path.startsWith("/api/devices/handshake/") -> {
                        val pending = mailbox.pollFirst()
                        if (pending == null) {
                            MockResponse().setResponseCode(404).setBody("not found")
                        } else {
                            val b64 = Base64.getUrlEncoder().withoutPadding().encodeToString(pending)
                            MockResponse().setResponseCode(200)
                                .setBody("""{"envelope_b64":"$b64"}""")
                        }
                    }
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
    }

    @After fun stopServer() { server.shutdown() }

    /** Build a wallet "signer" mirroring an MWA wallet (deterministic Ed25519). */
    private fun walletSigner(seed: ByteArray): Pair<Envelope.Ed25519BodySigner, String> {
        val priv = Ed25519PrivateKeyParameters(seed, 0)
        val pub = priv.generatePublicKey().encoded
        val did = Envelope.didKeyFromVerifying(pub)
        val signer = Envelope.Ed25519BodySigner { msg ->
            val s = Ed25519Signer().apply { init(true, priv) }
            s.update(msg, 0, msg.size)
            s.generateSignature()
        }
        return signer to did
    }

    private fun freshUnlockedVault(walletSeed: ByteArray): VaultStore {
        val priv = Ed25519PrivateKeyParameters(walletSeed, 0)
        val pub = priv.generatePublicKey().encoded
        val did = Envelope.didKeyFromVerifying(pub)
        val vault = VaultStore.createInMemoryForTests(did)
        // Pretend the same wallet sig that derives vault material is what
        // the user's wallet provides. We use a different challenge each
        // time the unlock challenge is generated, so use a fixed
        // signMessage that signs whatever's handed to it.
        vault.unlock(VaultStore.SignMessage { challenge ->
            val s = Ed25519Signer().apply { init(true, priv) }
            s.update(challenge, 0, challenge.size)
            VaultStore.SignResult.Success(s.generateSignature())
        })
        return vault
    }

    @Test fun end_to_end_imports_dek() {
        val walletSeed = ByteArray(32) { 0xAA.toByte() }
        val (walletSigner, walletDid) = walletSigner(walletSeed)

        val sender = freshUnlockedVault(walletSeed)
        val receiver = freshUnlockedVault(walletSeed)

        // Sender has a session with a known DEK.
        val sessionId = "s-pair-1"
        val senderDek = sender.getOrCreateSessionDek(sessionId)

        // Receiver generates a handshake.
        val receiverHandshake = PairDevice.createReceiverHandshake(walletDid)

        // Run the receiver poll on a separate thread; sender posts.
        val receiverThread = Thread {
            val result = PairDevice.awaitHandshake(server.url("").toString().trimEnd('/'), receiverHandshake, receiver)
            assertEquals(walletDid, result.senderDid)
            assertEquals(1, result.imported)
        }
        receiverThread.start()

        val count = PairDevice.sendHandshake(
            baseUrl = server.url("").toString().trimEnd('/'),
            descriptor = receiverHandshake.descriptor,
            vault = sender,
            senderWalletDid = walletDid,
            walletSigner = walletSigner,
            sessionIds = listOf(sessionId),
        )
        assertEquals(1, count)
        receiverThread.join(TimeUnit.SECONDS.toMillis(5))

        // Receiver vault now holds the imported DEK.
        val received = receiver.getOrCreateSessionDek(sessionId)
        assertArrayEquals(senderDek, received)
    }

    @Test fun receiver_rejects_sender_did_mismatch() {
        val walletSeed = ByteArray(32) { 0xAA.toByte() }
        val (walletSigner, _walletDid) = walletSigner(walletSeed)

        // Receiver pins a DIFFERENT DID than the sender's.
        val unrelatedSeed = ByteArray(32) { 0x55 }
        val (_, unrelatedDid) = walletSigner(unrelatedSeed)
        val receiverHandshake = PairDevice.createReceiverHandshake(unrelatedDid)

        val sender = freshUnlockedVault(walletSeed)
        sender.getOrCreateSessionDek("s-1")
        val receiver = freshUnlockedVault(walletSeed)

        // Sender posts an envelope signed with walletDid (not unrelatedDid).
        PairDevice.sendHandshake(
            baseUrl = server.url("").toString().trimEnd('/'),
            descriptor = receiverHandshake.descriptor,
            vault = sender,
            senderWalletDid = Envelope.didKeyFromVerifying(
                Ed25519PrivateKeyParameters(walletSeed, 0).generatePublicKey().encoded,
            ),
            walletSigner = walletSigner,
        )

        // Receiver awaits — must throw on the sender-DID-mismatch check.
        assertThrows(java.io.IOException::class.java) {
            PairDevice.awaitHandshake(server.url("").toString().trimEnd('/'), receiverHandshake, receiver)
        }
    }

    @Test fun tampered_envelope_fails_signature() {
        val walletSeed = ByteArray(32) { 0xAA.toByte() }
        val (walletSigner, walletDid) = walletSigner(walletSeed)

        val sender = freshUnlockedVault(walletSeed)
        sender.getOrCreateSessionDek("s-1")
        val receiver = freshUnlockedVault(walletSeed)
        val receiverHandshake = PairDevice.createReceiverHandshake(walletDid)

        // Custom dispatcher: intercept the POST, flip a byte, then deliver.
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(req: RecordedRequest): MockResponse {
                val path = req.path ?: ""
                return when {
                    req.method == "POST" && path == "/api/devices/handshake" -> {
                        val obj = JSONObject(req.body.readUtf8())
                        val envelope = Base64.getUrlDecoder().decode(obj.getString("envelope_b64"))
                        // Flip a byte well inside the ciphertext (avoid the 64-byte trailing sig).
                        envelope[envelope.size - 65 - 4] = (envelope[envelope.size - 65 - 4].toInt() xor 1).toByte()
                        mailbox.add(envelope)
                        MockResponse().setResponseCode(200).setBody("""{"ok":true,"expires_at_ms":0}""")
                    }
                    req.method == "GET" && path.startsWith("/api/devices/handshake/") -> {
                        val pending = mailbox.pollFirst()
                        if (pending == null) {
                            MockResponse().setResponseCode(404).setBody("not found")
                        } else {
                            val b64 = Base64.getUrlEncoder().withoutPadding().encodeToString(pending)
                            MockResponse().setResponseCode(200)
                                .setBody("""{"envelope_b64":"$b64"}""")
                        }
                    }
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }

        PairDevice.sendHandshake(
            baseUrl = server.url("").toString().trimEnd('/'),
            descriptor = receiverHandshake.descriptor,
            vault = sender,
            senderWalletDid = walletDid,
            walletSigner = walletSigner,
        )

        assertThrows(Throwable::class.java) {
            PairDevice.awaitHandshake(server.url("").toString().trimEnd('/'), receiverHandshake, receiver)
        }
    }
}
