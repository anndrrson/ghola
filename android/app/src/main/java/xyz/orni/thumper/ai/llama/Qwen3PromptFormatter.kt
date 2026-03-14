package xyz.orni.thumper.ai.llama

import org.json.JSONArray
import org.json.JSONObject

object Qwen3PromptFormatter {

    fun format(messages: JSONArray, tools: JSONArray, system: String): String {
        val sb = StringBuilder()

        // System message with tool definitions
        sb.append("<|im_start|>system\n")
        sb.append(system)
        if (tools.length() > 0) {
            sb.append("\n\n# Tools\n\nYou are provided with the following tools. To call a tool, respond with a <tool_call> block.\n\n<tools>\n")
            sb.append(convertToolsToQwen(tools).toString(2))
            sb.append("\n</tools>\n\nFor each tool call, return a JSON object with the tool name and arguments:\n<tool_call>\n{\"name\": \"tool_name\", \"arguments\": {\"arg1\": \"value1\"}}\n</tool_call>")
        }
        sb.append("<|im_end|>\n")

        // Conversation messages
        for (i in 0 until messages.length()) {
            val msg = messages.getJSONObject(i)
            val role = msg.getString("role")
            val content = msg.get("content")

            when (role) {
                "user" -> formatUserMessage(sb, content)
                "assistant" -> formatAssistantMessage(sb, content)
            }
        }

        // Trigger assistant generation
        sb.append("<|im_start|>assistant\n")

        return sb.toString()
    }

    private fun formatUserMessage(sb: StringBuilder, content: Any) {
        sb.append("<|im_start|>user\n")

        when (content) {
            is String -> sb.append(content)
            is JSONArray -> {
                for (i in 0 until content.length()) {
                    val block = content.getJSONObject(i)
                    when (block.getString("type")) {
                        "text" -> sb.append(block.getString("text"))
                        "tool_result" -> {
                            val toolUseId = block.getString("tool_use_id")
                            val resultContent = block.get("content")
                            val resultText = when (resultContent) {
                                is String -> resultContent
                                is JSONArray -> extractTextFromContent(resultContent)
                                else -> resultContent.toString()
                            }
                            sb.append("<tool_response>\n")
                            sb.append(resultText)
                            sb.append("\n</tool_response>")
                        }
                    }
                    if (i < content.length() - 1) sb.append("\n")
                }
            }
        }

        sb.append("<|im_end|>\n")
    }

    private fun formatAssistantMessage(sb: StringBuilder, content: Any) {
        sb.append("<|im_start|>assistant\n")

        when (content) {
            is String -> sb.append(content)
            is JSONArray -> {
                for (i in 0 until content.length()) {
                    val block = content.getJSONObject(i)
                    when (block.getString("type")) {
                        "text" -> sb.append(block.getString("text"))
                        "tool_use" -> {
                            val name = block.getString("name")
                            val input = block.getJSONObject("input")
                            sb.append("<tool_call>\n")
                            sb.append(JSONObject().apply {
                                put("name", name)
                                put("arguments", input)
                            }.toString())
                            sb.append("\n</tool_call>")
                        }
                    }
                    if (i < content.length() - 1) sb.append("\n")
                }
            }
        }

        sb.append("<|im_end|>\n")
    }

    private fun extractTextFromContent(content: JSONArray): String {
        val sb = StringBuilder()
        for (i in 0 until content.length()) {
            val block = content.getJSONObject(i)
            when (block.getString("type")) {
                "text" -> sb.append(block.getString("text"))
                "image" -> sb.append("[image]")
            }
        }
        return sb.toString()
    }

    private fun convertToolsToQwen(tools: JSONArray): JSONArray {
        val qwenTools = JSONArray()
        for (i in 0 until tools.length()) {
            val tool = tools.getJSONObject(i)
            qwenTools.put(JSONObject().apply {
                put("type", "function")
                put("function", JSONObject().apply {
                    put("name", tool.getString("name"))
                    put("description", tool.getString("description"))
                    put("parameters", tool.getJSONObject("input_schema"))
                })
            })
        }
        return qwenTools
    }
}
