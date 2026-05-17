package xyz.ghola.app.ui

/**
 * Pure-Kotlin helpers extracted out of [SettingsActivity] so they can
 * be unit-tested without Robolectric. The JVM unit-test config in
 * `app/build.gradle.kts` runs with `isReturnDefaultValues = true` and
 * does not stand up an Android runtime — anything that touches
 * `Context`, resources, or views has to be exercised on a real device.
 * String constants here are NOT user-facing copy — they're status-token
 * keys that the activity maps to `R.string.*` lookups. Keeps the
 * Settings UI deterministic and the assertions cheap.
 *
 * Added by Phase γ.4 / L3 for the HuggingFace Bearer token field.
 */
object SettingsHelpers {

    /** Stable status tokens for the HF token field. */
    const val HF_STATUS_SET: String = "set"
    const val HF_STATUS_NOT_SET: String = "not_set"

    /**
     * Map "is a token persisted right now?" to the status token the
     * UI should render. Trivial today, but isolated so a future
     * "expired" / "rate-limited" status doesn't sprawl across the
     * activity.
     */
    fun formatHfTokenStatus(hasToken: Boolean): String =
        if (hasToken) HF_STATUS_SET else HF_STATUS_NOT_SET

    /**
     * Cheap sanity check for a HuggingFace personal-access token.
     * HF tokens are `hf_` + ~32+ chars of base62. We intentionally
     * don't enforce the full charset (HF may evolve it) — the goal
     * here is "warn on obvious paste errors", not "validate the
     * server-side format". Used to surface a non-blocking warning
     * in [SettingsActivity.onSaveHfToken]; the token is still saved
     * either way so the user can paste a future-format token if
     * HuggingFace changes the prefix.
     *
     * Returns `false` for blank input, wrong-prefix input, or input
     * shorter than the minimum the HF docs have ever published.
     */
    fun looksLikeHfToken(raw: String?): Boolean {
        val t = raw?.trim().orEmpty()
        if (t.isEmpty()) return false
        if (!t.startsWith("hf_")) return false
        // hf_ + ≥30 chars body — the shortest token HF has ever issued
        // (legacy `read` tokens) was 34 chars total; pad the floor down
        // a bit for safety.
        return t.length >= 33
    }
}
