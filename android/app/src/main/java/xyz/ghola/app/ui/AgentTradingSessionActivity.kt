package xyz.ghola.app.ui

import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import com.solana.mobilewalletadapter.clientlib.ActivityResultSender
import xyz.ghola.app.R

/**
 * Thin host retained for the manifest entry / deep links. The set-limits →
 * arm-agent pipeline now lives in [AgentTradingSheet]; this activity simply
 * presents that sheet over a dark backdrop and finishes when it is dismissed
 * (see [AgentTradingSheet.onDismiss]). Keeping a single implementation in the
 * sheet means MarketChart and this entry point share one code path.
 */
class AgentTradingSessionActivity : AppCompatActivity(), TradeSenderHost {

    companion object {
        const val EXTRA_PRODUCT_ID = "product_id"
    }

    // Created during construction (before STARTED) so the sheet can use it for
    // the Mobile Wallet Adapter approval round-trip.
    override val tradeResultSender = ActivityResultSender(this)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_sheet_host)
        if (savedInstanceState == null) {
            AgentTradingSheet.newInstance(intent.getStringExtra(EXTRA_PRODUCT_ID))
                .show(supportFragmentManager, AgentTradingSheet.TAG)
        }
    }
}
