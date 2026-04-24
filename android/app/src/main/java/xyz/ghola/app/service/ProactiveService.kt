package xyz.ghola.app.service

import android.Manifest
import android.content.pm.PackageManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.app.Service
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.content.ContextCompat
import xyz.ghola.app.R
import xyz.ghola.app.ai.SecureStorage
import xyz.ghola.app.cloud.SaidCloudClient
import xyz.ghola.app.cloud.ThumperCloudClient
import xyz.ghola.app.ui.AgentDetailActivity

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
        private const val AGENT_EARNING_CHANNEL_ID = "ghola_agent_earnings"
        private const val NOTIFICATION_ID = 1001
        // Per-agent last-seen earnings (in micro USDC) to dedupe notifications
        // across poll cycles. Keyed by agent ID.
        private val lastSeenEarnings = mutableMapOf<String, Long>()
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

                // Phase M8: Poll said-cloud for agent earnings deltas and
                // fire a local notification when an agent earns USDC. This
                // is the polling fallback that delivers the "wake up and see
                // your agent earned $0.42" loop without needing FCM.
                if (secureStorage.hasSaidAuth()) {
                    pollAgentEarnings(secureStorage)
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
            val proactive = NotificationChannel(
                CHANNEL_ID,
                "Ghola Proactive",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Background monitoring for tasks and notifications"
            }
            val earnings = NotificationChannel(
                AGENT_EARNING_CHANNEL_ID,
                "Agent Earnings",
                NotificationManager.IMPORTANCE_DEFAULT
            ).apply {
                description = "Fires when your owned AI agents earn or spend USDC"
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(proactive)
            manager.createNotificationChannel(earnings)
        }
    }

    /**
     * Phase M8 polling fallback: for each owned agent, fetch the latest
     * earnings summary and compare against the last-seen amount. If the
     * received total grew since the previous poll, fire a local notification
     * attributing the earning to the agent.
     */
    private fun pollAgentEarnings(secureStorage: SecureStorage) {
        try {
            val client = SaidCloudClient(
                secureStorage.getSaidBaseUrl(),
                secureStorage.getSaidToken()
            )
            val agents = client.listAgents() ?: return

            for (i in 0 until agents.length()) {
                val agent = agents.getJSONObject(i)
                val agentId = agent.optString("id", "")
                if (agentId.isEmpty()) continue

                val displayName = agent.optString("display_name", "Your agent")
                val earnings = client.getAgentEarnings(agentId) ?: continue
                val received = earnings.optLong("total_received_micro_usdc", 0L)

                val lastSeen = lastSeenEarnings[agentId]
                if (lastSeen != null && received > lastSeen) {
                    val delta = received - lastSeen
                    fireEarningsNotification(agentId, displayName, delta)
                }
                lastSeenEarnings[agentId] = received
            }
        } catch (e: Exception) {
            Log.w(TAG, "Agent earnings poll error", e)
        }
    }

    private fun fireEarningsNotification(agentId: String, displayName: String, deltaMicroUsdc: Long) {
        val usdc = deltaMicroUsdc / 1_000_000.0
        val amount = if (usdc < 0.01) String.format("\$%.4f", usdc) else String.format("\$%.2f", usdc)

        val intent = Intent(this, AgentDetailActivity::class.java).apply {
            putExtra(AgentDetailActivity.EXTRA_AGENT_ID, agentId)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pending = PendingIntent.getActivity(
            this,
            agentId.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, AGENT_EARNING_CHANNEL_ID)
                .setContentTitle("$displayName earned $amount")
                .setContentText("Tap to see the details")
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentIntent(pending)
                .setAutoCancel(true)
                .build()
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
                .setContentTitle("$displayName earned $amount")
                .setContentText("Tap to see the details")
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentIntent(pending)
                .setAutoCancel(true)
                .build()
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.POST_NOTIFICATIONS
            ) != PackageManager.PERMISSION_GRANTED
        ) {
            Log.w(TAG, "Skipping earnings notification; POST_NOTIFICATIONS not granted")
            return
        }

        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        // Stable notification id per agent — replaces the previous earning
        // notification instead of stacking them.
        manager.notify(agentId.hashCode(), notification)
    }
}
