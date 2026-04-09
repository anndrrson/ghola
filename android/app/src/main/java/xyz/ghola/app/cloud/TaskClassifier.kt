package xyz.ghola.app.cloud

import android.util.Log

/**
 * Routes user input to either cloud services or on-device agent.
 * Uses keyword matching first (fast), falls back to LLM classification.
 */
object TaskClassifier {

    private const val TAG = "TaskClassifier"

    enum class TaskRoute {
        CLOUD_CALL,    // Phone call via Bland AI
        CLOUD_EMAIL,   // Email via Gmail API
        CLOUD_CALENDAR,// Calendar management
        DEVICE,        // On-device agent (existing path)
        CHAT           // General conversation
    }

    data class Classification(
        val route: TaskRoute,
        val templateId: String? = null,
        val confidence: Float = 1.0f
    )

    // --- Keyword patterns for instant classification ---

    private val CALL_PATTERNS = listOf(
        "call ", "phone ", "ring ",
        "book a table", "book a reservation", "make a reservation",
        "reserve a table", "book me a table",
        "schedule an appointment", "make an appointment", "book an appointment",
        "call customer service", "call support",
        "cancel my subscription", "cancel my service"
    )

    private val EMAIL_PATTERNS = listOf(
        "email ", "send an email", "draft an email", "write an email",
        "email about", "send a message to",
        "request a refund", "ask for a refund",
        "follow up", "send a follow-up",
        "complain about", "file a complaint",
        "cancel subscription email", "unsubscribe"
    )

    private val CALENDAR_PATTERNS = listOf(
        "add to calendar", "create an event", "schedule a meeting",
        "what's on my calendar", "my schedule", "upcoming meetings",
        "remind me", "set a reminder"
    )

    // Templates matched by keyword
    private val CALL_TEMPLATES = mapOf(
        "book a table" to "book_restaurant",
        "book a reservation" to "book_restaurant",
        "make a reservation" to "book_restaurant",
        "reserve a table" to "book_restaurant",
        "book me a table" to "book_restaurant",
        "schedule an appointment" to "schedule_appointment",
        "make an appointment" to "schedule_appointment",
        "book an appointment" to "schedule_appointment",
        "call customer service" to "customer_service",
        "call support" to "customer_service",
        "cancel my subscription" to "cancel_service",
        "cancel my service" to "cancel_service"
    )

    private val EMAIL_TEMPLATES = mapOf(
        "request a refund" to "request_refund",
        "ask for a refund" to "request_refund",
        "follow up" to "follow_up",
        "send a follow-up" to "follow_up",
        "complain about" to "complaint",
        "file a complaint" to "complaint",
        "cancel subscription email" to "cancel_subscription"
    )

    /**
     * Classify user input into a task route.
     * Returns DEVICE for anything that should go to the existing on-device agent.
     */
    fun classify(input: String, hasCloudAuth: Boolean): Classification {
        if (!hasCloudAuth) {
            // No cloud auth → everything goes to device
            return Classification(TaskRoute.DEVICE)
        }

        val normalized = input.trim().lowercase()

        // Check call patterns
        for (pattern in CALL_PATTERNS) {
            if (normalized.contains(pattern)) {
                val templateId = CALL_TEMPLATES.entries
                    .firstOrNull { normalized.contains(it.key) }
                    ?.value
                Log.d(TAG, "Matched CLOUD_CALL pattern: '$pattern' template=$templateId")
                return Classification(TaskRoute.CLOUD_CALL, templateId)
            }
        }

        // Check email patterns
        for (pattern in EMAIL_PATTERNS) {
            if (normalized.contains(pattern)) {
                val templateId = EMAIL_TEMPLATES.entries
                    .firstOrNull { normalized.contains(it.key) }
                    ?.value
                Log.d(TAG, "Matched CLOUD_EMAIL pattern: '$pattern' template=$templateId")
                return Classification(TaskRoute.CLOUD_EMAIL, templateId)
            }
        }

        // Check calendar patterns
        for (pattern in CALENDAR_PATTERNS) {
            if (normalized.contains(pattern)) {
                Log.d(TAG, "Matched CLOUD_CALENDAR pattern: '$pattern'")
                return Classification(TaskRoute.CLOUD_CALENDAR)
            }
        }

        // Default: route to device agent (existing AgentController path)
        Log.d(TAG, "No cloud pattern matched → DEVICE")
        return Classification(TaskRoute.DEVICE)
    }
}
