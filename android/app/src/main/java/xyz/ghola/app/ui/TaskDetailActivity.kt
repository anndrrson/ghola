package xyz.ghola.app.ui

import android.os.Bundle
import android.widget.Button
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.Toolbar
import xyz.ghola.app.R
import xyz.ghola.app.ai.SecureStorage
import xyz.ghola.app.cloud.ThumperCloudClient

/**
 * Shows details of a cloud task — progress, steps, result, transcript.
 */
class TaskDetailActivity : AppCompatActivity() {

    private lateinit var secureStorage: SecureStorage
    private var taskId: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_task_detail)

        val toolbar = findViewById<Toolbar>(R.id.toolbar)
        setSupportActionBar(toolbar)
        supportActionBar?.setDisplayHomeAsUpEnabled(true)
        toolbar.setNavigationOnClickListener { finish() }

        secureStorage = SecureStorage(this)
        taskId = intent.getStringExtra("task_id")

        if (taskId == null) {
            Toast.makeText(this, "No task ID", Toast.LENGTH_SHORT).show()
            finish()
            return
        }

        loadTask()
    }

    private fun loadTask() {
        val token = secureStorage.getCloudAuthToken() ?: return
        val client = ThumperCloudClient(secureStorage.getCloudBaseUrl(), token)

        Thread {
            val task = client.getTask(taskId!!)
            runOnUiThread {
                if (task != null) {
                    findViewById<TextView>(R.id.taskType).text =
                        task.optString("task_type", "Unknown").replaceFirstChar { it.uppercase() }
                    findViewById<TextView>(R.id.taskStatus).text =
                        task.optString("status", "unknown").replace("_", " ")
                    findViewById<TextView>(R.id.taskParams).text =
                        task.optJSONObject("params")?.toString(2) ?: "No parameters"
                    findViewById<TextView>(R.id.taskResult).text =
                        task.optJSONObject("result")?.toString(2) ?: "Pending..."

                    val errorMsg = task.optString("error_message", "")
                    if (errorMsg.isNotEmpty()) {
                        findViewById<TextView>(R.id.taskError).apply {
                            text = errorMsg
                            visibility = android.view.View.VISIBLE
                        }
                    }

                    // Cancel button
                    val cancelBtn = findViewById<Button>(R.id.cancelButton)
                    val status = task.optString("status")
                    if (status in listOf("pending", "in_progress", "awaiting_approval")) {
                        cancelBtn.visibility = android.view.View.VISIBLE
                        cancelBtn.setOnClickListener { cancelTask() }
                    }

                    // Approve button (for email drafts)
                    val approveBtn = findViewById<Button>(R.id.approveButton)
                    if (status == "awaiting_approval" && task.optString("task_type") == "email") {
                        approveBtn.visibility = android.view.View.VISIBLE
                        approveBtn.setOnClickListener { approveEmail(task) }
                    }
                } else {
                    Toast.makeText(this, "Failed to load task", Toast.LENGTH_SHORT).show()
                }
            }
        }.start()
    }

    private fun cancelTask() {
        val token = secureStorage.getCloudAuthToken() ?: return
        val client = ThumperCloudClient(secureStorage.getCloudBaseUrl(), token)

        Thread {
            val result = client.cancelTask(taskId!!)
            runOnUiThread {
                if (result != null) {
                    Toast.makeText(this, "Task cancelled", Toast.LENGTH_SHORT).show()
                    loadTask() // Refresh
                } else {
                    Toast.makeText(this, "Failed to cancel", Toast.LENGTH_SHORT).show()
                }
            }
        }.start()
    }

    private fun approveEmail(task: org.json.JSONObject) {
        Toast.makeText(this, "Sending email...", Toast.LENGTH_SHORT).show()

        val token = secureStorage.getCloudAuthToken() ?: return
        val client = ThumperCloudClient(secureStorage.getCloudBaseUrl(), token)

        Thread {
            // Find the email_action linked to this task
            val emails = client.listEmails()
            if (emails != null) {
                for (i in 0 until emails.length()) {
                    val email = emails.getJSONObject(i)
                    if (email.optString("status") == "draft") {
                        val emailId = email.optString("id")
                        val result = client.sendEmail(emailId)
                        runOnUiThread {
                            if (result != null) {
                                Toast.makeText(this, "Email sent!", Toast.LENGTH_SHORT).show()
                                loadTask() // Refresh to show updated status
                            } else {
                                Toast.makeText(this, "Failed to send email", Toast.LENGTH_SHORT).show()
                            }
                        }
                        return@Thread
                    }
                }
            }
            runOnUiThread {
                Toast.makeText(this, "No draft email found for this task", Toast.LENGTH_SHORT).show()
            }
        }.start()
    }
}
