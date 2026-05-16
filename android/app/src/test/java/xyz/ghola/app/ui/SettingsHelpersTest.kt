package xyz.ghola.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * JVM unit tests for [SettingsHelpers]. Lives alongside the rest of
 * the `app/src/test` suite — the project's unit-test config runs with
 * `isReturnDefaultValues = true` and does NOT ship Robolectric, so
 * anything that touches `Context` or resources has to be exercised on
 * a real device. The pure-Kotlin helpers extracted in
 * [SettingsHelpers] are the testable shape; the View wiring around
 * them in [SettingsActivity] is exercised by hand on the Seeker.
 */
class SettingsHelpersTest {

    // ── formatHfTokenStatus ─────────────────────────────────────────

    @Test
    fun `status is 'set' when a token is persisted`() {
        assertEquals(
            SettingsHelpers.HF_STATUS_SET,
            SettingsHelpers.formatHfTokenStatus(hasToken = true),
        )
    }

    @Test
    fun `status is 'not_set' when no token is persisted`() {
        assertEquals(
            SettingsHelpers.HF_STATUS_NOT_SET,
            SettingsHelpers.formatHfTokenStatus(hasToken = false),
        )
    }

    // ── looksLikeHfToken ────────────────────────────────────────────

    @Test
    fun `valid hf-prefixed token is accepted`() {
        // 36-char body — realistic for an HF read token.
        assertTrue(SettingsHelpers.looksLikeHfToken("hf_abcdefghijklmnopqrstuvwxyz0123456789AB"))
    }

    @Test
    fun `valid token is accepted after trimming whitespace`() {
        assertTrue(SettingsHelpers.looksLikeHfToken("  hf_abcdefghijklmnopqrstuvwxyz0123456789AB  "))
    }

    @Test
    fun `empty string is rejected`() {
        assertFalse(SettingsHelpers.looksLikeHfToken(""))
    }

    @Test
    fun `null is rejected`() {
        assertFalse(SettingsHelpers.looksLikeHfToken(null))
    }

    @Test
    fun `wrong-prefix token is rejected`() {
        assertFalse(SettingsHelpers.looksLikeHfToken("sk_abcdefghijklmnopqrstuvwxyz0123456789"))
    }

    @Test
    fun `too-short hf-prefixed token is rejected`() {
        // hf_ + 5 chars total — well below the published HF token floor.
        assertFalse(SettingsHelpers.looksLikeHfToken("hf_abc"))
    }
}
