package xyz.ghola.app.ui

import android.app.Activity
import android.content.Intent
import com.google.android.material.bottomnavigation.BottomNavigationView
import xyz.ghola.app.R

/**
 * Phase M6: Shared bottom navigation across top-level activities.
 *
 * Activity-based navigation (NOT Fragments) — intentional choice per the plan:
 * Fragment migration would churn lifecycle logic in the accessibility-sensitive
 * AgentController, and the codebase is Activity-heavy already. Each tab maps
 * to a fresh Intent with FLAG_ACTIVITY_REORDER_TO_FRONT so the back stack
 * stays compact.
 *
 * The caller passes its own current tab ID so the helper can skip re-launching
 * the current screen when the user taps the active tab.
 */
object BottomNavHelper {

    fun attach(activity: Activity, currentTabId: Int, navView: BottomNavigationView) {
        if (navView.menu.findItem(currentTabId) != null) {
            navView.selectedItemId = currentTabId
        }
        navView.setOnItemSelectedListener { item ->
            if (item.itemId == currentTabId) {
                return@setOnItemSelectedListener true
            }
            val target: Class<*>? = when (item.itemId) {
                R.id.tab_assistant -> HomeActivity::class.java
                R.id.tab_agents -> AgentsActivity::class.java
                R.id.tab_activity -> ActivityFeedActivity::class.java
                R.id.tab_messages -> MessagesActivity::class.java
                else -> null
            }
            if (target != null) {
                val intent = Intent(activity, target).apply {
                    // REORDER_TO_FRONT keeps the back stack compact without
                    // tearing down and recreating each activity every tap.
                    flags = Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or
                            Intent.FLAG_ACTIVITY_SINGLE_TOP
                }
                activity.startActivity(intent)
                activity.overridePendingTransition(0, 0)
            }
            true
        }
    }
}
