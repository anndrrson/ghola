package xyz.ghola.app.service

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ApplicationInfo
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import android.util.DisplayMetrics
import android.view.WindowManager
import org.json.JSONArray
import org.json.JSONObject

/**
 * Provides device information: battery, screen, connectivity, installed apps.
 */
class DeviceInfoProvider(private val context: Context) {

    fun getDeviceInfo(): JSONObject {
        return JSONObject().apply {
            put("model", Build.MODEL)
            put("manufacturer", Build.MANUFACTURER)
            put("android_version", Build.VERSION.RELEASE)
            put("sdk_version", Build.VERSION.SDK_INT)

            // Screen info
            val wm = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
            val metrics = DisplayMetrics()
            @Suppress("DEPRECATION")
            wm.defaultDisplay.getRealMetrics(metrics)
            put("screen_width", metrics.widthPixels)
            put("screen_height", metrics.heightPixels)
            put("screen_density", metrics.density.toDouble())

            // Battery
            val batteryStatus = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            val level = batteryStatus?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
            val scale = batteryStatus?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
            val batteryPct = if (level >= 0 && scale > 0) (level * 100 / scale) else -1
            val status = batteryStatus?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
            val isCharging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
                    status == BatteryManager.BATTERY_STATUS_FULL
            put("battery_level", batteryPct)
            put("battery_charging", isCharging)

            // Phase α — thermal + power-save + instantaneous current draw.
            //
            // Thermal status (API 29+) and power-save mode are read off the
            // PowerManager. Pre-Q we surface "NONE" rather than null so
            // downstream filters (the upcoming BackendSelector) don't have to
            // branch on SDK level.
            //
            // BATTERY_PROPERTY_CURRENT_NOW is OEM-dependent — some vendors
            // return microamperes, some milliamperes, some return zero, and
            // a few return Integer.MIN_VALUE when the property isn't wired up.
            // Per Phase α spec: treat MIN_VALUE *and* 0 as "unavailable" and
            // emit JSON `null` instead of a misleading numeric reading.
            val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
            val thermalLabel = if (pm != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ThermalState.fromInt(pm.currentThermalStatus).label
            } else {
                "NONE"
            }
            put("thermal_state", thermalLabel)
            put("power_save_mode", pm?.isPowerSaveMode ?: false)

            val bm = context.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager
            val currentNowRaw: Long? = bm?.getLongProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_NOW)
            val currentNow: Long? = when {
                currentNowRaw == null -> null
                currentNowRaw == Long.MIN_VALUE -> null
                currentNowRaw == Integer.MIN_VALUE.toLong() -> null
                currentNowRaw == 0L -> null
                else -> currentNowRaw
            }
            if (currentNow != null) {
                put("battery_current_now_ua", currentNow)
            } else {
                put("battery_current_now_ua", JSONObject.NULL)
            }

            // Connectivity
            val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            val network = cm.activeNetwork
            val capabilities = if (network != null) cm.getNetworkCapabilities(network) else null
            put("wifi_connected", capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ?: false)
            put("cellular_connected", capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) ?: false)
        }
    }

    fun getInstalledApps(): JSONArray {
        val pm = context.packageManager
        val apps = JSONArray()

        val packages = pm.getInstalledApplications(0)
        for (appInfo in packages) {
            // Only include apps with a launcher intent (user-visible apps)
            if (pm.getLaunchIntentForPackage(appInfo.packageName) != null) {
                apps.put(JSONObject().apply {
                    put("package", appInfo.packageName)
                    put("label", pm.getApplicationLabel(appInfo).toString())
                })
            }
        }

        return apps
    }
}
