package xyz.ghola.app.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import xyz.ghola.app.R

sealed class ChatMessage {
    data class UserMessage(val text: String) : ChatMessage()
    data class AssistantMessage(var text: String, var isStreaming: Boolean = false) : ChatMessage()
    data class Screenshot(val base64: String, var bitmap: Bitmap? = null) : ChatMessage()
    data class ErrorMessage(val text: String) : ChatMessage()
}

class ChatAdapter : RecyclerView.Adapter<RecyclerView.ViewHolder>() {

    companion object {
        private const val TYPE_USER = 0
        private const val TYPE_ASSISTANT = 1
        private const val TYPE_SCREENSHOT = 3
        private const val TYPE_ERROR = 4
    }

    private val messages = mutableListOf<ChatMessage>()
    var onScrollToBottom: (() -> Unit)? = null

    override fun getItemViewType(position: Int): Int = when (messages[position]) {
        is ChatMessage.UserMessage -> TYPE_USER
        is ChatMessage.AssistantMessage -> TYPE_ASSISTANT
        is ChatMessage.Screenshot -> TYPE_SCREENSHOT
        is ChatMessage.ErrorMessage -> TYPE_ERROR
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
        val inflater = LayoutInflater.from(parent.context)
        return when (viewType) {
            TYPE_USER -> UserViewHolder(inflater.inflate(R.layout.item_message_user, parent, false))
            TYPE_ASSISTANT -> AssistantViewHolder(inflater.inflate(R.layout.item_message_assistant, parent, false))
            TYPE_SCREENSHOT -> ScreenshotViewHolder(inflater.inflate(R.layout.item_message_screenshot, parent, false))
            TYPE_ERROR -> ErrorViewHolder(inflater.inflate(R.layout.item_message_error, parent, false))
            else -> throw IllegalArgumentException("Unknown view type: $viewType")
        }
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
        when (val msg = messages[position]) {
            is ChatMessage.UserMessage -> (holder as UserViewHolder).bind(msg)
            is ChatMessage.AssistantMessage -> (holder as AssistantViewHolder).bind(msg)
            is ChatMessage.Screenshot -> (holder as ScreenshotViewHolder).bind(msg)
            is ChatMessage.ErrorMessage -> (holder as ErrorViewHolder).bind(msg)
        }
    }

    override fun getItemCount(): Int = messages.size

    fun addMessage(msg: ChatMessage) {
        messages.add(msg)
        notifyItemInserted(messages.size - 1)
        onScrollToBottom?.invoke()
    }

    fun updateLastAssistantText(text: String) {
        val pos = findLastAssistantPosition()
        if (pos >= 0) {
            (messages[pos] as? ChatMessage.AssistantMessage)?.text = text
            notifyItemChanged(pos)
            onScrollToBottom?.invoke()
        }
    }

    fun findLastAssistantPosition(): Int {
        for (i in messages.indices.reversed()) {
            if (messages[i] is ChatMessage.AssistantMessage) return i
        }
        return -1
    }

    fun clear() {
        val size = messages.size
        messages.clear()
        notifyItemRangeRemoved(0, size)
    }

    // ViewHolders

    class UserViewHolder(view: View) : RecyclerView.ViewHolder(view) {
        private val textView: TextView = view.findViewById(R.id.messageText)
        fun bind(msg: ChatMessage.UserMessage) {
            textView.text = msg.text
        }
    }

    class AssistantViewHolder(view: View) : RecyclerView.ViewHolder(view) {
        private val textView: TextView = view.findViewById(R.id.messageText)
        fun bind(msg: ChatMessage.AssistantMessage) {
            textView.text = msg.text
        }
    }

    class ScreenshotViewHolder(view: View) : RecyclerView.ViewHolder(view) {
        private val imageView: ImageView = view.findViewById(R.id.screenshotImage)
        fun bind(msg: ChatMessage.Screenshot) {
            if (msg.bitmap == null) {
                try {
                    val bytes = Base64.decode(msg.base64, Base64.DEFAULT)
                    msg.bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                } catch (e: Exception) {
                    // Failed to decode
                }
            }
            msg.bitmap?.let { imageView.setImageBitmap(it) }
        }
    }

    class ErrorViewHolder(view: View) : RecyclerView.ViewHolder(view) {
        private val textView: TextView = view.findViewById(R.id.errorText)
        fun bind(msg: ChatMessage.ErrorMessage) {
            textView.text = msg.text
        }
    }
}
