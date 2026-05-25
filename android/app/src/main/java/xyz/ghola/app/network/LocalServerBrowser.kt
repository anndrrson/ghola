package xyz.ghola.app.network

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.util.Log

/**
 * A server discovered via mDNS. NOTE (M finding): mDNS responders are
 * UNTRUSTED — any peer on the LAN can advertise `_ghola._tcp` with an
 * arbitrary [host]/[name]. Discovery here is a convenience only; the actual
 * trust decision happens at pair time (PIN + server-presented fingerprint,
 * see [xyz.ghola.app.cloud.LocalHomeClient]). The cleartext [baseUrl] is
 * dev-only: the release network-security policy blocks cleartext to RFC1918
 * and [LocalHomeClient.pair] refuses to run outside debug builds.
 */
data class LocalGholaServer(
    val name: String,
    val host: String,
    val port: Int,
    val models: List<String>,
) {
    val baseUrl: String = "http://$host:$port"
}

class LocalServerBrowser(
    context: Context,
    private val onServersChanged: (List<LocalGholaServer>) -> Unit,
) {
    private val nsd = context.getSystemService(Context.NSD_SERVICE) as NsdManager
    private val servers = linkedMapOf<String, LocalGholaServer>()
    private var listener: NsdManager.DiscoveryListener? = null

    fun start() {
        stop()
        val discoveryListener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(regType: String) = Unit
            override fun onDiscoveryStopped(serviceType: String) = Unit
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                Log.w(TAG, "NSD start failed: $errorCode")
                stop()
            }
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {
                Log.w(TAG, "NSD stop failed: $errorCode")
            }
            override fun onServiceFound(serviceInfo: NsdServiceInfo) {
                if (serviceInfo.serviceType != SERVICE_TYPE) return
                resolve(serviceInfo)
            }
            override fun onServiceLost(serviceInfo: NsdServiceInfo) {
                servers.remove(serviceInfo.serviceName)
                onServersChanged(servers.values.toList())
            }
        }
        listener = discoveryListener
        nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discoveryListener)
    }

    fun stop() {
        val l = listener ?: return
        runCatching { nsd.stopServiceDiscovery(l) }
        listener = null
    }

    private fun resolve(serviceInfo: NsdServiceInfo) {
        nsd.resolveService(serviceInfo, object : NsdManager.ResolveListener {
            override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                Log.w(TAG, "NSD resolve failed for ${serviceInfo.serviceName}: $errorCode")
            }

            override fun onServiceResolved(resolved: NsdServiceInfo) {
                val host = resolved.host?.hostAddress ?: return
                val models = resolved.attributes["models"]
                    ?.let { String(it, Charsets.UTF_8) }
                    ?.split(',')
                    ?.map { it.trim() }
                    ?.filter { it.isNotEmpty() }
                    .orEmpty()
                servers[resolved.serviceName] = LocalGholaServer(
                    name = resolved.serviceName,
                    host = host,
                    port = resolved.port,
                    models = models,
                )
                onServersChanged(servers.values.toList())
            }
        })
    }

    companion object {
        private const val TAG = "LocalServerBrowser"
        private const val SERVICE_TYPE = "_ghola._tcp."
    }
}
