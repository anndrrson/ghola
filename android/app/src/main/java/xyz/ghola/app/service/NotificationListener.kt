package xyz.ghola.app.service

import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

/**
 * Captures incoming notifications for the device_read_notifications MCP tool.
 * Maintains a ring buffer of the most recent notifications.
 */
class NotificationListener : NotificationListenerService() {

    companion object {
        private const val TAG = "ThumperNotify"
        private const val MAX_NOTIFICATIONS = 50

        var instance: NotificationListener? = null
            private set

        private val recentNotifications = mutableListOf<NotificationEntry>()
    }

    override fun onListenerConnected() {
        super.onListenerConnected()
        instance = this
        Log.i(TAG, "Notification listener connected")
    }

    override fun onListenerDisconnected() {
        super.onListenerDisconnected()
        instance = null
        Log.i(TAG, "Notification listener disconnected")
    }

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        sbn ?: return

        val notification = sbn.notification ?: return
        val extras = notification.extras

        val entry = NotificationEntry(
            key = sbn.key,
            packageName = sbn.packageName,
            title = extras.getCharSequence("android.title")?.toString(),
            text = extras.getCharSequence("android.text")?.toString(),
            timestamp = sbn.postTime
        )

        synchronized(recentNotifications) {
            recentNotifications.add(0, entry)
            if (recentNotifications.size > MAX_NOTIFICATIONS) {
                recentNotifications.removeAt(recentNotifications.lastIndex)
            }
        }

        Log.d(TAG, "Notification from ${sbn.packageName}: ${entry.title}")
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification?) {
        // We keep removed notifications in the buffer for querying
    }

    /**
     * Get recent notifications as a JSON array.
     */
    fun getRecentNotifications(limit: Int = 20): JSONArray {
        val result = JSONArray()
        synchronized(recentNotifications) {
            for (entry in recentNotifications.take(limit)) {
                result.put(JSONObject().apply {
                    put("key", entry.key)
                    put("package", entry.packageName)
                    if (entry.title != null) put("title", entry.title)
                    if (entry.text != null) put("text", entry.text)
                    put("timestamp", entry.timestamp)
                })
            }
        }
        return result
    }

    /**
     * Dismiss a notification by its key.
     */
    fun dismissNotification(key: String): Boolean {
        return try {
            cancelNotification(key)
            true
        } catch (e: Exception) {
            Log.e(TAG, "Failed to dismiss notification: $key", e)
            false
        }
    }

    data class NotificationEntry(
        val key: String,
        val packageName: String,
        val title: String?,
        val text: String?,
        val timestamp: Long
    )
}
