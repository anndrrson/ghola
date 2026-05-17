package xyz.ghola.app.demo

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * # DemoBroadcastReceiver
 *
 * Debug-only hook for firing [DemoScript] from adb without requiring a real
 * microphone or spoken input. Declared statically in AndroidManifest.xml so
 * the component can be targeted by name via `adb shell am broadcast -n ...`,
 * and so it receives broadcasts even when HomeActivity isn't foregrounded.
 *
 * ## Usage
 *
 * ```
 * adb shell "am broadcast \
 *     -n xyz.ghola.app/.demo.DemoBroadcastReceiver \
 *     --es text 'open the ghola website'"
 * ```
 *
 * ## Why it exists
 *
 * Live demos are not the place to discover that SpeechRecognizer disagreed
 * with the presenter's accent. The presenter rehearses spoken phrases on
 * the phone, AND has a hotkey fallback (via adb over USB or a local Shortcut)
 * that fires the same [DemoScript] path with a known-good string. Muscle
 * memory for both.
 */
class DemoBroadcastReceiver : BroadcastReceiver() {

    companion object {
        const val ACTION = "xyz.ghola.app.DEMO"
        const val EXTRA_TEXT = "text"
        private const val TAG = "GholaDemo"
    }

    override fun onReceive(context: Context?, intent: Intent?) {
        val ctx = context ?: return
        val text = intent?.getStringExtra(EXTRA_TEXT) ?: return
        Log.i(TAG, "Broadcast received: '$text'")
        val handled = DemoScript.handle(ctx.applicationContext, text)
        Log.i(TAG, "DemoScript.handle → $handled")
    }
}
