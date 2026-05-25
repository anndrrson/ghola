package xyz.ghola.app.ui

import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import xyz.ghola.app.service.ThumperAccessibilityService

object AccessibilitySetup {
    private const val ACCESSIBILITY_DETAILS_ACTION = "android.settings.ACCESSIBILITY_DETAILS_SETTINGS"
    private const val ACCESSIBILITY_SERVICE_COMPONENT_EXTRA =
        "android.provider.extra.ACCESSIBILITY_SERVICE_COMPONENT_NAME"

    fun isEnabled(context: Context): Boolean {
        if (ThumperAccessibilityService.instance != null) return true

        val expected = serviceComponent(context).flattenToString()
        val enabledServices = Settings.Secure.getString(
            context.contentResolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
        ).orEmpty()

        return enabledServices
            .split(':')
            .any { it.equals(expected, ignoreCase = true) }
    }

    fun open(context: Context) {
        val detailsIntent = baseIntent(context, ACCESSIBILITY_DETAILS_ACTION).apply {
            data = Uri.parse("package:${context.packageName}")
            putExtra(ACCESSIBILITY_SERVICE_COMPONENT_EXTRA, serviceComponent(context))
        }
        val fallbackIntent = baseIntent(context, Settings.ACTION_ACCESSIBILITY_SETTINGS)

        runCatching {
            context.startActivity(detailsIntent)
        }.recoverCatching {
            context.startActivity(fallbackIntent)
        }
    }

    private fun baseIntent(context: Context, action: String): Intent {
        return Intent(action).apply {
            if (context !is Activity) {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
        }
    }

    private fun serviceComponent(context: Context): ComponentName {
        return ComponentName(context, ThumperAccessibilityService::class.java)
    }
}
