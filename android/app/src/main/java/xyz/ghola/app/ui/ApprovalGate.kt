package xyz.ghola.app.ui

import android.content.Context
import android.util.Log
import xyz.ghola.app.solana.WalletSessionCoordinator

/**
 * Central marker for user-visible wallet approvals.
 *
 * This class does not show UI by itself; callers must only enter [request]
 * from explicit tap handlers whose label describes the approval.
 */
object ApprovalGate {
    private const val TAG = "ApprovalGate"

    enum class Reason {
        CONNECT,
        UNLOCK_CHAT,
        PAIR_DEVICE,
        APPROVE_AGENT_SESSION,
        APPROVE_ORDER,
    }

    suspend fun <T> request(
        context: Context,
        reason: Reason,
        caller: String,
        action: suspend () -> T,
    ): T {
        Log.i(TAG, "wallet approval requested reason=$reason caller=$caller package=${context.packageName}")
        return WalletSessionCoordinator.withApproval(
            context = context,
            reason = reason.name,
            caller = caller,
            action = action,
        )
    }

    fun recordLocalApproval(reason: Reason, caller: String) {
        Log.i(TAG, "local approval recorded reason=$reason caller=$caller")
        WalletSessionCoordinator.recordLocal(null, reason.name, caller)
    }
}
