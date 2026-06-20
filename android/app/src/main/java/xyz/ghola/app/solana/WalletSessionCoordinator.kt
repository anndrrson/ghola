package xyz.ghola.app.solana

import android.content.Context
import android.util.Log
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.time.Instant

object WalletSessionCoordinator {
    private const val TAG = "WalletSessionCoord"
    private val approvalMutex = Mutex()
    private val recentApprovals = ArrayDeque<ApprovalRecord>()

    data class ApprovalRecord(
        val reason: String,
        val caller: String,
        val packageName: String,
        val approvedAt: String,
    )

    suspend fun <T> withApproval(
        context: Context,
        reason: String,
        caller: String,
        action: suspend () -> T,
    ): T = approvalMutex.withLock {
        record(context, reason, caller)
        action()
    }

    fun recordLocal(context: Context?, reason: String, caller: String) {
        record(context, reason, caller)
    }

    fun recent(): List<ApprovalRecord> = synchronized(recentApprovals) {
        recentApprovals.toList()
    }

    private fun record(context: Context?, reason: String, caller: String) {
        val item = ApprovalRecord(
            reason = reason,
            caller = caller,
            packageName = context?.packageName ?: "unknown",
            approvedAt = Instant.now().toString(),
        )
        synchronized(recentApprovals) {
            recentApprovals.addFirst(item)
            while (recentApprovals.size > 20) {
                recentApprovals.removeLast()
            }
        }
        Log.i(TAG, "wallet approval recorded reason=$reason caller=$caller package=${item.packageName}")
    }
}
