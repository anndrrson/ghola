package xyz.orni.thumper.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log
import xyz.orni.thumper.R
import xyz.orni.thumper.ai.SecureStorage
import xyz.orni.thumper.cloud.ThumperCloudClient

/**
 * Foreground service for proactive monitoring:
 * - Forwards important notifications to cloud for AI classification
 * - Polls for task updates
 * - Receives push-triggered wakeups
 */
class ProactiveService : Service() {

    companion object {
        private const val TAG = "ProactiveService"
        private const val CHANNEL_ID = "thumper_proactive"
        private const val NOTIFICATION_ID = 1001
    }

    private var isRunning = false

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!isRunning) {
            isRunning = true
            startForeground(NOTIFICATION_ID, buildNotification())
            Log.i(TAG, "Proactive service started")

            // Start monitoring loop
            Thread {
                monitorLoop()
            }.start()
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        super.onDestroy()
        isRunning = false
        Log.i(TAG, "Proactive service stopped")
    }

    private fun monitorLoop() {
        val secureStorage = SecureStorage(this)

        while (isRunning) {
            try {
                if (secureStorage.hasCloudAuth()) {
                    val client = ThumperCloudClient(
                        secureStorage.getCloudBaseUrl(),
                        secureStorage.getCloudAuthToken()!!
                    )

                    // Check for active tasks with updates
                    val tasks = client.listTasks(status = "in_progress")
                    if (tasks != null && tasks.length() > 0) {
                        for (i in 0 until tasks.length()) {
                            val task = tasks.getJSONObject(i)
                            val status = task.optString("status")
                            val taskType = task.optString("task_type")
                            Log.d(TAG, "Active task: ${task.optString("id")} type=$taskType status=$status")
                        }
                    }

                    // Forward recent notifications for AI analysis
                    val notificationListener = NotificationListener.instance
                    if (notificationListener != null) {
                        val recent = notificationListener.getRecentNotifications(5)
                        if (recent.length() > 0) {
                            // TODO: Send to cloud for classification
                            // Cloud responds with actionable suggestions
                        }
                    }
                }

                // Sleep for 30 seconds between checks
                Thread.sleep(30_000)
            } catch (e: InterruptedException) {
                break
            } catch (e: Exception) {
                Log.e(TAG, "Monitor loop error", e)
                Thread.sleep(60_000) // Back off on error
            }
        }
    }

    private fun buildNotification(): Notification {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
                .setContentTitle("Thumper")
                .setContentText("Monitoring for tasks and notifications")
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setOngoing(true)
                .build()
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
                .setContentTitle("Thumper")
                .setContentText("Monitoring for tasks and notifications")
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setOngoing(true)
                .build()
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Thumper Proactive",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Background monitoring for tasks and notifications"
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(channel)
        }
    }
}
