package xyz.orni.thumper.service

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ApplicationInfo
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
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
