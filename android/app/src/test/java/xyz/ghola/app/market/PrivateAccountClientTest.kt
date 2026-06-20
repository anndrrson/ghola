package xyz.ghola.app.market

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class PrivateAccountClientTest {
    private lateinit var server: MockWebServer

    @Before fun startServer() {
        server = MockWebServer()
        server.start()
    }

    @After fun stopServer() {
        server.shutdown()
    }

    @Test fun autopilot_create_attaches_mobile_proof_headers() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(201).setBody("""
            {
              "version": 1,
              "session": {
                "autopilot_session_id": "autopilot_test",
                "status": "pending_worker",
                "session_policy": {}
              },
              "events": []
            }
        """.trimIndent()))
        val client = PrivateAccountClient(
            baseUrl = server.url("/").toString(),
            tokenProvider = { "cloud-token" },
            liveProofProvider = { method, path, _ ->
                Result.success(
                    mapOf(
                        "x-ghola-mobile-proof-version" to "1",
                        "x-ghola-mobile-wallet" to "wallet-test",
                        "x-ghola-mobile-proof-timestamp" to "1780000000000",
                        "x-ghola-mobile-proof-nonce" to "nonce-test-123",
                        "x-ghola-mobile-proof-signature-b64" to "sig-test",
                        "x-test-method" to method,
                        "x-test-path" to path,
                    ),
                )
            },
        )

        val result = client.createAutopilotSession(AutopilotSessionDraft(productId = "BTC-USD"))
        val request = server.takeRequest()

        assertTrue(result.ok)
        assertEquals("/v1/private-account/autopilot/sessions", request.path)
        assertEquals("Bearer cloud-token", request.getHeader("authorization"))
        assertEquals("1", request.getHeader("x-ghola-mobile-proof-version"))
        assertEquals("wallet-test", request.getHeader("x-ghola-mobile-wallet"))
        assertEquals("POST", request.getHeader("x-test-method"))
        assertEquals("/v1/private-account/autopilot/sessions", request.getHeader("x-test-path"))
    }

    @Test fun readiness_get_parses_blockers() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""
            {
              "version": 1,
              "product_id": "BTC-USD",
              "can_arm": true,
              "can_live_submit": false,
              "worker_configured": true,
              "wallet_binding_status": "active",
              "blockers": ["hyperliquid:venue_access_or_funding_required"],
              "venue_readiness": []
            }
        """.trimIndent()))
        val client = PrivateAccountClient(
            baseUrl = server.url("/").toString(),
            tokenProvider = { "cloud-token" },
        )

        val readiness = client.fetchAutopilotReadiness("btc-usd", "wallet-test").getOrThrow()
        val request = server.takeRequest()

        assertEquals("/v1/private-account/autopilot/readiness?product_id=BTC-USD&wallet_pubkey=wallet-test", request.path)
        assertEquals(true, readiness.canArm)
        assertEquals(false, readiness.canLiveSubmit)
        assertEquals("active", readiness.walletBindingStatus)
        assertEquals(listOf("hyperliquid:venue_access_or_funding_required"), readiness.blockers)
    }

    @Test fun wallet_binding_challenge_and_bind_use_private_account_backend() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""
            {
              "version": 1,
              "wallet_pubkey": "wallet-test",
              "message": "bind-message",
              "timestamp_ms": "1780000000000",
              "nonce": "nonce-test",
              "expires_at": "2026-06-03T00:00:00.000Z"
            }
        """.trimIndent()))
        server.enqueue(MockResponse().setResponseCode(201).setBody("""
            {
              "version": 1,
              "status": "active",
              "binding_commitment": "binding-test",
              "wallet_commitment": "wallet-commitment-test",
              "created_at": "2026-06-03T00:00:00.000Z",
              "updated_at": "2026-06-03T00:00:00.000Z"
            }
        """.trimIndent()))
        val client = PrivateAccountClient(
            baseUrl = server.url("/").toString(),
            tokenProvider = { "cloud-token" },
        )

        val challenge = client.fetchMobileWalletBindingChallenge("wallet-test").getOrThrow()
        val bound = client.bindMobileWallet("wallet-test", challenge.getString("message"), "sig-b64")
        val challengeRequest = server.takeRequest()
        val bindRequest = server.takeRequest()

        assertEquals("/v1/private-account/wallet-bindings/challenge?wallet_pubkey=wallet-test", challengeRequest.path)
        assertEquals("Bearer cloud-token", challengeRequest.getHeader("authorization"))
        assertEquals("/v1/private-account/wallet-bindings", bindRequest.path)
        assertEquals("Bearer cloud-token", bindRequest.getHeader("authorization"))
        assertTrue(bound.ok)
    }
}
