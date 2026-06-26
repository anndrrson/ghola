package xyz.ghola.app.cloud

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Before
import org.junit.Test
import java.util.Base64
import java.util.concurrent.TimeUnit

class SaidCloudClientTest {

    private lateinit var server: MockWebServer

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun `siwsSignIn posts wallet payload to said auth endpoint`() {
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setBody(
                    """
                    {
                      "token": "said.jwt",
                      "user_id": "00000000-0000-0000-0000-000000000001",
                      "did": "",
                      "exp": 1780000000,
                      "refresh_token": "said.refresh",
                      "refresh_exp": 1790000000
                    }
                    """.trimIndent(),
                ),
        )

        val baseUrl = server.url("/v1").toString().trimEnd('/')
        val client = SaidCloudClient(baseUrl, null)
        val signature = ByteArray(64) { it.toByte() }

        val result = client.siwsSignIn(
            walletPubkey = "wallet111",
            nonce = "nonce222",
            challenge = "Sign in to Ghola\nNonce: nonce222",
            signature = signature,
        )

        assertNotNull(result)
        assertEquals("said.jwt", result!!.getString("token"))
        assertEquals("said.refresh", result.getString("refresh_token"))

        val request = server.takeRequest(1, TimeUnit.SECONDS)!!
        assertEquals("POST", request.method)
        assertEquals("/v1/auth/siws", request.path)

        val body = JSONObject(request.body.readUtf8())
        assertEquals("wallet111", body.getString("wallet_pubkey"))
        assertEquals("nonce222", body.getString("nonce"))
        assertEquals("Sign in to Ghola\nNonce: nonce222", body.getString("challenge"))
        assertEquals(
            Base64.getEncoder().encodeToString(signature),
            body.getString("signature"),
        )
    }
}
