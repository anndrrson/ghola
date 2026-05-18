use futures::StreamExt;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::CloudError;
use crate::privacy::{
    phone_preview, sensitive_text_hash, stored_approval_nonce_hash, NetworkScope, PrivacyApproval,
};
use crate::services::llm_router::ChatMsg;
use crate::state::AppState;

// ---------------------------------------------------------------------------
// Telegram API types (minimal)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct TelegramResponse<T> {
    ok: bool,
    result: Option<T>,
    description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TelegramUpdate {
    update_id: i64,
    message: Option<TelegramMessage>,
    callback_query: Option<TelegramCallbackQuery>,
}

#[derive(Debug, Deserialize)]
struct TelegramMessage {
    message_id: i64,
    from: Option<TelegramUser>,
    chat: TelegramChat,
    text: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TelegramUser {
    id: i64,
    first_name: String,
    username: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TelegramChat {
    id: i64,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct TelegramCallbackQuery {
    id: String,
    from: TelegramUser,
    message: Option<TelegramMessage>,
    data: Option<String>,
}

#[derive(Debug, Serialize)]
struct InlineKeyboardMarkup {
    inline_keyboard: Vec<Vec<InlineKeyboardButton>>,
}

#[derive(Debug, Serialize)]
struct InlineKeyboardButton {
    text: String,
    callback_data: String,
}

// ---------------------------------------------------------------------------
// Telegram Bot client
// ---------------------------------------------------------------------------

struct TelegramBot {
    token: String,
    client: reqwest::Client,
}

impl TelegramBot {
    fn new(token: &str) -> Self {
        Self {
            token: token.to_string(),
            client: reqwest::Client::new(),
        }
    }

    fn api_url(&self, method: &str) -> String {
        format!("https://api.telegram.org/bot{}/{}", self.token, method)
    }

    async fn get_updates(&self, offset: i64) -> Result<Vec<TelegramUpdate>, CloudError> {
        let resp = self
            .client
            .post(self.api_url("getUpdates"))
            .json(&serde_json::json!({
                "offset": offset,
                "timeout": 30,
                "allowed_updates": ["message", "callback_query"]
            }))
            .timeout(std::time::Duration::from_secs(35))
            .send()
            .await
            .map_err(|e| CloudError::Internal(format!("Telegram getUpdates failed: {e}")))?;

        let body: TelegramResponse<Vec<TelegramUpdate>> = resp
            .json()
            .await
            .map_err(|e| CloudError::Internal(format!("Telegram response parse failed: {e}")))?;

        if !body.ok {
            return Err(CloudError::Internal(format!(
                "Telegram API error: {}",
                body.description.unwrap_or_default()
            )));
        }

        Ok(body.result.unwrap_or_default())
    }

    async fn send_message(
        &self,
        chat_id: i64,
        text: &str,
        reply_markup: Option<&InlineKeyboardMarkup>,
    ) -> Result<TelegramMessage, CloudError> {
        let mut body = serde_json::json!({
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "Markdown",
        });
        if let Some(markup) = reply_markup {
            body["reply_markup"] = serde_json::to_value(markup)
                .map_err(|e| CloudError::Internal(format!("serialize markup: {e}")))?;
        }

        let resp = self
            .client
            .post(self.api_url("sendMessage"))
            .json(&body)
            .send()
            .await
            .map_err(|e| CloudError::Internal(format!("Telegram sendMessage failed: {e}")))?;

        let result: TelegramResponse<TelegramMessage> = resp
            .json()
            .await
            .map_err(|e| CloudError::Internal(format!("Telegram response parse failed: {e}")))?;

        result
            .result
            .ok_or_else(|| CloudError::Internal("Telegram sendMessage returned no result".into()))
    }

    async fn edit_message(
        &self,
        chat_id: i64,
        message_id: i64,
        text: &str,
        reply_markup: Option<&InlineKeyboardMarkup>,
    ) -> Result<(), CloudError> {
        let mut body = serde_json::json!({
            "chat_id": chat_id,
            "message_id": message_id,
            "text": text,
            "parse_mode": "Markdown",
        });
        if let Some(markup) = reply_markup {
            body["reply_markup"] = serde_json::to_value(markup)
                .map_err(|e| CloudError::Internal(format!("serialize markup: {e}")))?;
        }

        let _ = self
            .client
            .post(self.api_url("editMessageText"))
            .json(&body)
            .send()
            .await;

        Ok(())
    }

    async fn answer_callback_query(
        &self,
        callback_id: &str,
        text: Option<&str>,
    ) -> Result<(), CloudError> {
        let mut body = serde_json::json!({ "callback_query_id": callback_id });
        if let Some(t) = text {
            body["text"] = serde_json::Value::String(t.to_string());
        }

        let _ = self
            .client
            .post(self.api_url("answerCallbackQuery"))
            .json(&body)
            .send()
            .await;

        Ok(())
    }

    async fn set_my_commands(&self) -> Result<(), CloudError> {
        let commands = serde_json::json!({
            "commands": [
                { "command": "start", "description": "Start or link your account" },
                { "command": "link", "description": "Link with a code from ghola.xyz" },
                { "command": "unlink", "description": "Disconnect your Telegram" },
                { "command": "newchat", "description": "Start a fresh conversation" },
                { "command": "help", "description": "Show available commands" },
            ]
        });

        let _ = self
            .client
            .post(self.api_url("setMyCommands"))
            .json(&commands)
            .send()
            .await;

        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Long polling loop
// ---------------------------------------------------------------------------

pub async fn start_telegram_bot(state: AppState) {
    let token = match &state.config.telegram_bot_token {
        Some(t) => t.clone(),
        None => return,
    };

    let bot = TelegramBot::new(&token);

    if let Err(e) = bot.set_my_commands().await {
        tracing::warn!("failed to set Telegram bot commands: {e}");
    }

    tracing::info!("Telegram bot polling started");

    let mut offset: i64 = 0;
    let mut backoff_secs: u64 = 1;

    loop {
        match bot.get_updates(offset).await {
            Ok(updates) => {
                backoff_secs = 1;
                for update in updates {
                    offset = update.update_id + 1;

                    if let Some(msg) = update.message {
                        let state = state.clone();
                        let token = token.clone();
                        tokio::spawn(async move {
                            if let Err(e) = handle_message(&state, &token, msg).await {
                                tracing::error!("Telegram message handler error: {e}");
                            }
                        });
                    }

                    if let Some(cb) = update.callback_query {
                        let state = state.clone();
                        let token = token.clone();
                        tokio::spawn(async move {
                            if let Err(e) = handle_callback(&state, &token, cb).await {
                                tracing::error!("Telegram callback handler error: {e}");
                            }
                        });
                    }
                }
            }
            Err(e) => {
                tracing::warn!("Telegram polling error (retry in {backoff_secs}s): {e}");
                tokio::time::sleep(std::time::Duration::from_secs(backoff_secs)).await;
                backoff_secs = (backoff_secs * 2).min(60);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

async fn handle_message(
    state: &AppState,
    token: &str,
    msg: TelegramMessage,
) -> Result<(), CloudError> {
    let text = match msg.text.as_deref() {
        Some(t) => t.trim(),
        None => return Ok(()),
    };
    let chat_id = msg.chat.id;
    let tg_user = msg.from.as_ref();

    // Parse commands
    if text.starts_with('/') {
        let parts: Vec<&str> = text.splitn(2, ' ').collect();
        let cmd = parts[0].split('@').next().unwrap_or(parts[0]);
        let arg = parts.get(1).map(|s| s.trim()).unwrap_or("");

        match cmd {
            "/start" => return handle_start(state, token, chat_id, tg_user, arg).await,
            "/link" => return handle_link(state, token, chat_id, tg_user, arg).await,
            "/unlink" => return handle_unlink(state, token, chat_id, tg_user).await,
            "/newchat" => return handle_newchat(state, token, chat_id, tg_user).await,
            "/help" => return handle_help(token, chat_id).await,
            _ => {}
        }
    }

    // Regular chat message
    handle_chat(state, token, chat_id, tg_user, text).await
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async fn handle_start(
    state: &AppState,
    token: &str,
    chat_id: i64,
    tg_user: Option<&TelegramUser>,
    arg: &str,
) -> Result<(), CloudError> {
    let bot = TelegramBot::new(token);

    // Deep link: /start CODE
    if !arg.is_empty() {
        return handle_link(state, token, chat_id, tg_user, arg).await;
    }

    // Check if already linked
    let tg_user_id = tg_user.map(|u| u.id).unwrap_or(0);
    let linked = sqlx::query_scalar::<_, Uuid>(
        "SELECT user_id FROM telegram_links WHERE telegram_user_id = $1",
    )
    .bind(tg_user_id)
    .fetch_optional(&state.db)
    .await?;

    if linked.is_some() {
        bot.send_message(
            chat_id,
            "Welcome back! Just send me a message and I'll help you out.\n\nCommands:\n/newchat — Fresh conversation\n/unlink — Disconnect account\n/help — Show commands",
            None,
        ).await?;
    } else {
        bot.send_message(
            chat_id,
            "Hey! I'm Ghola, your AI assistant.\n\nTo get started, link your account:\n1. Go to ghola.xyz/settings\n2. Click the *Telegram* tab\n3. Click *Connect Telegram*\n4. Send me the code with /link CODE\n\nOr use the link provided on the settings page!",
            None,
        ).await?;
    }

    Ok(())
}

async fn handle_link(
    state: &AppState,
    token: &str,
    chat_id: i64,
    tg_user: Option<&TelegramUser>,
    code: &str,
) -> Result<(), CloudError> {
    let bot = TelegramBot::new(token);

    if code.is_empty() {
        bot.send_message(
            chat_id,
            "Please provide your link code: /link CODE\n\nGet your code at ghola.xyz/settings → Telegram",
            None,
        ).await?;
        return Ok(());
    }

    let tg_user_id = tg_user.map(|u| u.id).unwrap_or(0);
    let tg_username = tg_user.and_then(|u| u.username.as_deref());
    let tg_first_name = tg_user.map(|u| u.first_name.as_str()).unwrap_or("User");

    // Look up the code
    let row = sqlx::query_as::<_, (Uuid, Uuid)>(
        "SELECT id, user_id FROM telegram_link_codes WHERE code = $1 AND used = false AND expires_at > now()",
    )
    .bind(code.to_uppercase())
    .fetch_optional(&state.db)
    .await?;

    let (code_id, user_id) = match row {
        Some(r) => r,
        None => {
            bot.send_message(
                chat_id,
                "Invalid or expired code. Please generate a new one at ghola.xyz/settings → Telegram.",
                None,
            ).await?;
            return Ok(());
        }
    };

    // Mark code as used
    sqlx::query("UPDATE telegram_link_codes SET used = true WHERE id = $1")
        .bind(code_id)
        .execute(&state.db)
        .await?;

    // Upsert telegram link
    sqlx::query(
        r#"
        INSERT INTO telegram_links (user_id, telegram_user_id, telegram_username, telegram_first_name, chat_id)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (user_id) DO UPDATE SET
            telegram_user_id = $2,
            telegram_username = $3,
            telegram_first_name = $4,
            chat_id = $5,
            session_id = gen_random_uuid(),
            linked_at = now()
        "#,
    )
    .bind(user_id)
    .bind(tg_user_id)
    .bind(tg_username)
    .bind(tg_first_name)
    .bind(chat_id)
    .execute(&state.db)
    .await?;

    bot.send_message(
        chat_id,
        "Account linked! Just message me anytime and I'll help you out.\n\nTry: \"Call Joe's Pizza and book a table for 2 at 7pm\"",
        None,
    ).await?;

    Ok(())
}

async fn handle_unlink(
    state: &AppState,
    token: &str,
    chat_id: i64,
    tg_user: Option<&TelegramUser>,
) -> Result<(), CloudError> {
    let bot = TelegramBot::new(token);
    let tg_user_id = tg_user.map(|u| u.id).unwrap_or(0);

    let result = sqlx::query("DELETE FROM telegram_links WHERE telegram_user_id = $1")
        .bind(tg_user_id)
        .execute(&state.db)
        .await?;

    if result.rows_affected() > 0 {
        bot.send_message(
            chat_id,
            "Account unlinked. You can re-link anytime at ghola.xyz/settings.",
            None,
        )
        .await?;
    } else {
        bot.send_message(chat_id, "No linked account found.", None)
            .await?;
    }

    Ok(())
}

async fn handle_newchat(
    state: &AppState,
    token: &str,
    chat_id: i64,
    tg_user: Option<&TelegramUser>,
) -> Result<(), CloudError> {
    let bot = TelegramBot::new(token);
    let tg_user_id = tg_user.map(|u| u.id).unwrap_or(0);

    let result = sqlx::query(
        "UPDATE telegram_links SET session_id = gen_random_uuid() WHERE telegram_user_id = $1",
    )
    .bind(tg_user_id)
    .execute(&state.db)
    .await?;

    if result.rows_affected() > 0 {
        bot.send_message(chat_id, "Fresh conversation started!", None)
            .await?;
    } else {
        bot.send_message(
            chat_id,
            "Link your account first: ghola.xyz/settings → Telegram",
            None,
        )
        .await?;
    }

    Ok(())
}

async fn handle_help(token: &str, chat_id: i64) -> Result<(), CloudError> {
    let bot = TelegramBot::new(token);
    bot.send_message(
        chat_id,
        "*Ghola Commands*\n\n/newchat — Start a fresh conversation\n/link CODE — Link your ghola.xyz account\n/unlink — Disconnect your account\n/help — Show this message\n\nJust send me a message to chat!",
        None,
    ).await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Chat handler
// ---------------------------------------------------------------------------

async fn handle_chat(
    state: &AppState,
    token: &str,
    chat_id: i64,
    tg_user: Option<&TelegramUser>,
    text: &str,
) -> Result<(), CloudError> {
    let bot = TelegramBot::new(token);
    let tg_user_id = tg_user.map(|u| u.id).unwrap_or(0);

    // Look up linked account
    let link = sqlx::query_as::<_, (Uuid, Uuid)>(
        "SELECT user_id, session_id FROM telegram_links WHERE telegram_user_id = $1",
    )
    .bind(tg_user_id)
    .fetch_optional(&state.db)
    .await?;

    let (user_id, session_id) = match link {
        Some(l) => l,
        None => {
            bot.send_message(
                chat_id,
                "Link your account first!\n\n1. Go to ghola.xyz/settings\n2. Click *Telegram* tab\n3. Click *Connect Telegram*\n4. Send me the code",
                None,
            ).await?;
            return Ok(());
        }
    };

    // Send "Thinking..." placeholder
    let placeholder = bot.send_message(chat_id, "_Thinking..._", None).await?;

    // Save user message
    sqlx::query(
        "INSERT INTO chat_messages (user_id, session_id, role, content) VALUES ($1, $2, 'user', $3)",
    )
    .bind(user_id)
    .bind(session_id)
    .bind(text)
    .execute(&state.db)
    .await?;

    // Load recent history (last 20 messages)
    let rows = sqlx::query_as::<_, (String, String)>(
        "SELECT role, content FROM chat_messages WHERE session_id = $1 ORDER BY created_at DESC LIMIT 20",
    )
    .bind(session_id)
    .fetch_all(&state.db)
    .await?;

    let mut messages: Vec<ChatMsg> = rows
        .into_iter()
        .rev()
        .map(|(role, content)| ChatMsg { role, content })
        .collect();

    // If no messages loaded (shouldn't happen since we just inserted), add the current one
    if messages.is_empty() {
        messages.push(ChatMsg {
            role: "user".to_string(),
            content: text.to_string(),
        });
    }

    let system = "You are Ghola, an AI personal assistant chatting via Telegram. Be concise (under 2000 chars when possible). \
        Use Telegram markdown: *bold*, _italic_, `code`. \
        When the user asks you to make a phone call or send an email, explain that external actions require in-app Ghola approval. \
        Do not echo full phone numbers, email recipients, message bodies, provider payloads, or approval metadata in Telegram.";

    // Generate response (non-streaming — collect from stream)
    let response = generate_chat(state, user_id, &messages, Some(system)).await;

    match response {
        Ok(reply) => {
            // Check for call/email intent and add action buttons
            let intent = crate::services::llm_router::classify_intent(state, user_id, text).await;
            let markup = match intent {
                Ok(i) if i.category == "call" && i.confidence > 0.7 => {
                    let task_id = Uuid::new_v4();
                    // Store pending intent
                    let params = i.extracted_params.clone();
                    let _ = sqlx::query(
                        "INSERT INTO tasks (id, user_id, task_type, status, params) VALUES ($1, $2, 'call', 'pending', $3)",
                    )
                    .bind(task_id)
                    .bind(user_id)
                    .bind(&params)
                    .execute(&state.db)
                    .await;

                    Some(InlineKeyboardMarkup {
                        inline_keyboard: vec![vec![
                            InlineKeyboardButton {
                                text: "Make the call".to_string(),
                                callback_data: format!("call:{task_id}"),
                            },
                            InlineKeyboardButton {
                                text: "Cancel".to_string(),
                                callback_data: format!("cancel:{task_id}"),
                            },
                        ]],
                    })
                }
                Ok(i) if i.category == "email" && i.confidence > 0.7 => {
                    let task_id = Uuid::new_v4();
                    let params = i.extracted_params.clone();
                    let _ = sqlx::query(
                        "INSERT INTO tasks (id, user_id, task_type, status, params) VALUES ($1, $2, 'email', 'pending', $3)",
                    )
                    .bind(task_id)
                    .bind(user_id)
                    .bind(&params)
                    .execute(&state.db)
                    .await;

                    Some(InlineKeyboardMarkup {
                        inline_keyboard: vec![vec![
                            InlineKeyboardButton {
                                text: "Send email".to_string(),
                                callback_data: format!("email:{task_id}"),
                            },
                            InlineKeyboardButton {
                                text: "Cancel".to_string(),
                                callback_data: format!("cancel:{task_id}"),
                            },
                        ]],
                    })
                }
                _ => None,
            };

            // Chunk response if >4096 chars (Telegram limit)
            if reply.len() > 4096 {
                let chunks: Vec<&str> = reply
                    .as_bytes()
                    .chunks(4096)
                    .map(|c| std::str::from_utf8(c).unwrap_or(""))
                    .collect();

                // Edit placeholder with first chunk
                bot.edit_message(chat_id, placeholder.message_id, chunks[0], None)
                    .await?;

                // Send remaining chunks
                for (i, chunk) in chunks[1..].iter().enumerate() {
                    let mk = if i == chunks.len() - 2 {
                        markup.as_ref()
                    } else {
                        None
                    };
                    bot.send_message(chat_id, chunk, mk).await?;
                }
            } else {
                bot.edit_message(chat_id, placeholder.message_id, &reply, markup.as_ref())
                    .await?;
            }

            // Save assistant message
            sqlx::query(
                "INSERT INTO chat_messages (user_id, session_id, role, content) VALUES ($1, $2, 'assistant', $3)",
            )
            .bind(user_id)
            .bind(session_id)
            .bind(&reply)
            .execute(&state.db)
            .await?;
        }
        Err(e) => {
            tracing::error!("Telegram chat generation failed: {e}");
            bot.edit_message(
                chat_id,
                placeholder.message_id,
                "Sorry, something went wrong. Please try again.",
                None,
            )
            .await?;
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Callback handler (inline button presses)
// ---------------------------------------------------------------------------

async fn handle_callback(
    state: &AppState,
    token: &str,
    cb: TelegramCallbackQuery,
) -> Result<(), CloudError> {
    let bot = TelegramBot::new(token);
    let data = cb.data.as_deref().unwrap_or("");

    bot.answer_callback_query(&cb.id, None).await?;

    let parts: Vec<&str> = data.splitn(2, ':').collect();
    if parts.len() != 2 {
        return Ok(());
    }

    let action = parts[0];
    let task_id: Uuid = match parts[1].parse() {
        Ok(id) => id,
        Err(_) => return Ok(()),
    };

    let chat_id = cb.message.as_ref().map(|m| m.chat.id).unwrap_or(0);
    if chat_id == 0 {
        return Ok(());
    }

    match action {
        "call" => {
            // Get task params
            let params = sqlx::query_scalar::<_, serde_json::Value>(
                "SELECT params FROM tasks WHERE id = $1",
            )
            .bind(task_id)
            .fetch_optional(&state.db)
            .await?;

            let params = match params {
                Some(p) => p,
                None => {
                    bot.send_message(chat_id, "Task not found.", None).await?;
                    return Ok(());
                }
            };

            let phone = params["phone_number"]
                .as_str()
                .or_else(|| params["phone"].as_str())
                .unwrap_or("");
            let objective = params["objective"]
                .as_str()
                .or_else(|| params["description"].as_str())
                .unwrap_or("Make a phone call");

            if phone.is_empty() {
                bot.send_message(
                    chat_id,
                    "No phone number found in request. Please specify a number.",
                    None,
                )
                .await?;
                return Ok(());
            }

            bot.send_message(chat_id, "Calling through external provider...", None)
                .await?;

            // Update task status
            sqlx::query("UPDATE tasks SET status = 'in_progress' WHERE id = $1")
                .bind(task_id)
                .execute(&state.db)
                .await?;

            // Get user_id from task
            let user_id = sqlx::query_scalar::<_, Uuid>("SELECT user_id FROM tasks WHERE id = $1")
                .bind(task_id)
                .fetch_one(&state.db)
                .await?;

            let approval_row = sqlx::query_as::<
                _,
                (
                    Option<String>,
                    Option<String>,
                    Option<chrono::DateTime<chrono::Utc>>,
                    Option<String>,
                    Option<String>,
                ),
            >(
                "SELECT privacy_mode, network_scope, user_approved_at, approval_nonce, approval_summary FROM tasks WHERE id = $1",
            )
            .bind(task_id)
            .fetch_one(&state.db)
            .await?;
            let approval = PrivacyApproval {
                privacy_mode: approval_row.0,
                network_scope: approval_row.1,
                user_approved_at: approval_row.2,
                approval_nonce: approval_row.3,
                approval_summary: approval_row.4,
            };
            if approval.require_for(NetworkScope::CallExecution).is_err() {
                bot.send_message(
                    chat_id,
                    "Call execution is blocked until the task has explicit approval.",
                    None,
                )
                .await?;
                return Ok(());
            }
            let local_script = serde_json::json!({
                "task": objective,
                "first_sentence": "Hi, I'm calling on behalf of my client.",
            });

            // Initiate call
            match crate::services::call_service::start_call(
                state,
                user_id,
                task_id,
                phone,
                objective,
                Some(&local_script),
            )
            .await
            {
                Ok(bland_call_id) => {
                    // Insert into calls table
                    sqlx::query(
                        r#"
                        INSERT INTO calls
                            (task_id, user_id, bland_call_id, phone_number, phone_number_hash,
                             phone_number_preview, objective, outcome, privacy_mode, network_scope,
                             user_approved_at, approval_nonce, approval_summary)
                        VALUES ($1, $2, $3, $4, $5, $6, '[redacted after provider handoff]',
                                'in_progress', $7, $8, $9, $10, $11)
                        "#,
                    )
                    .bind(task_id)
                    .bind(user_id)
                    .bind(&bland_call_id)
                    .bind(phone_preview(phone))
                    .bind(sensitive_text_hash(phone))
                    .bind(phone_preview(phone))
                    .bind(approval.privacy_mode.as_deref())
                    .bind(approval.network_scope.as_deref())
                    .bind(approval.user_approved_at)
                    .bind(
                        approval
                            .approval_nonce
                            .as_deref()
                            .map(stored_approval_nonce_hash),
                    )
                    .bind(approval.approval_summary.as_deref())
                    .execute(&state.db)
                    .await?;
                }
                Err(e) => {
                    bot.send_message(chat_id, &format!("Failed to start call: {e}"), None)
                        .await?;
                    sqlx::query(
                        "UPDATE tasks SET status = 'failed', error_message = $1 WHERE id = $2",
                    )
                    .bind(format!("{e}"))
                    .bind(task_id)
                    .execute(&state.db)
                    .await?;
                }
            }
        }
        "email" => {
            bot.send_message(
                chat_id,
                "Email actions are blocked in Telegram. Open Ghola to review and approve the draft without sending plaintext through Telegram.",
                None,
            )
                .await?;
            sqlx::query(
                "UPDATE tasks SET status = 'awaiting_approval', error_message = COALESCE(error_message, 'Email actions require in-app approval.') WHERE id = $1",
            )
            .bind(task_id)
            .execute(&state.db)
            .await?;
        }
        "cancel" => {
            sqlx::query("UPDATE tasks SET status = 'cancelled' WHERE id = $1")
                .bind(task_id)
                .execute(&state.db)
                .await?;
            bot.send_message(chat_id, "Cancelled.", None).await?;
        }
        _ => {}
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Non-streaming chat generation (collects from stream)
// ---------------------------------------------------------------------------

async fn generate_chat(
    state: &AppState,
    user_id: Uuid,
    messages: &[ChatMsg],
    system: Option<&str>,
) -> Result<String, CloudError> {
    let stream =
        crate::services::llm_router::generate_stream(state, user_id, messages, system).await?;
    let mut full_text = String::new();
    futures::pin_mut!(stream);
    while let Some(result) = stream.next().await {
        match result {
            Ok(text) => full_text.push_str(&text),
            Err(e) => return Err(e),
        }
    }
    Ok(full_text)
}

// ---------------------------------------------------------------------------
// Helper: look up telegram link for a user (used by other modules)
// ---------------------------------------------------------------------------

pub async fn get_telegram_link(
    pool: &sqlx::PgPool,
    user_id: Uuid,
) -> Result<Option<(i64,)>, sqlx::Error> {
    sqlx::query_as::<_, (i64,)>("SELECT chat_id FROM telegram_links WHERE user_id = $1")
        .bind(user_id)
        .fetch_optional(pool)
        .await
}

/// Send a notification to a user's linked Telegram account
pub async fn notify_user(token: &str, chat_id: i64, message: &str) -> Result<(), CloudError> {
    let bot = TelegramBot::new(token);
    bot.send_message(chat_id, message, None).await?;
    Ok(())
}
