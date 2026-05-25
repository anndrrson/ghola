package xyz.ghola.app.cloud

import android.app.Activity
import android.app.Application
import android.content.Context

object TurnkeyAuthBridge {
    fun initialize(app: Application) = Unit
    fun isConfigured(context: Context): Boolean = false
    suspend fun signIn(activity: Activity): Result<DeviceSigner> =
        Result.failure(UnsupportedOperationException("Turnkey is not enabled in the Seeker build"))
    fun cached(context: Context): DeviceSigner? = null
    suspend fun signOut(context: Context) = Unit
}
