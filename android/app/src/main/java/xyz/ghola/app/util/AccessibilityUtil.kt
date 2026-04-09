package xyz.ghola.app.util

import android.content.ComponentName
import android.content.Context
import android.provider.Settings
import android.text.TextUtils
import xyz.ghola.app.service.ThumperAccessibilityService

/**
 * # AccessibilityUtil
 *
 * Single source of truth for "is Ghola's accessibility service currently
 * enabled on this device." Used by the home screen to decide whether to
 * show the [xyz.ghola.app.ui.AccessibilityOnboardingActivity] cinematic
 * prompt and by the settings screen to render a green-check status.
 *
 * ## How Android exposes this
 *
 * Android does not give apps a direct "is my accessibility service on"
 * API — there is no `AccessibilityManager.isMyServiceEnabled()`. The
 * canonical approach is to read the `Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES`
 * string, which is a colon-separated list of ComponentName entries, then
 * check if this app's service component is present.
 *
 * ## Why not trust `ThumperAccessibilityService.instance`?
 *
 * The static `instance` field is set in the service's `onServiceConnected`
 * lifecycle hook and cleared in `onDestroy`. It's a reasonable signal but
 * NOT reliable — Android can bind and unbind the service for various
 * reasons (power save, user toggled another app's service), and the
 * static field has brief windows of staleness. The Settings.Secure string
 * is the authoritative source.
 */
object AccessibilityUtil {

    /**
     * True if Ghola's `ThumperAccessibilityService` is currently enabled
     * in the system's accessibility settings. Does NOT require the service
     * to be actively bound — it only checks the user's toggle state.
     */
    fun isServiceEnabled(context: Context): Boolean {
        val targetComponent = ComponentName(
            context.packageName,
            ThumperAccessibilityService::class.java.name,
        )
        val enabledServices = Settings.Secure.getString(
            context.contentResolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
        ) ?: return false

        // The string is colon-separated "pkg/ServiceClass:pkg2/ServiceClass2".
        // Split and compare each entry as a ComponentName so we tolerate
        // whitespace, trailing slashes, and missing fully-qualified names.
        val splitter = TextUtils.SimpleStringSplitter(':')
        splitter.setString(enabledServices)
        while (splitter.hasNext()) {
            val entry = splitter.next().trim()
            if (entry.isEmpty()) continue
            val parsed = ComponentName.unflattenFromString(entry) ?: continue
            if (parsed == targetComponent) return true
        }
        return false
    }
}
