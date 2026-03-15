use std::path::Path;

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::SqlitePool;

pub async fn init_pool(db_path: &Path) -> Result<SqlitePool, sqlx::Error> {
    // Ensure parent directory exists
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).ok();
    }

    let options = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(std::time::Duration::from_secs(5));

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await?;

    // Run migrations inline
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS chat_messages (
            id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
            session_id TEXT NOT NULL,
            role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
            content TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now'))
        )
        "#,
    )
    .execute(&pool)
    .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_chat_session ON chat_messages(session_id)")
        .execute(&pool)
        .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
        "#,
    )
    .execute(&pool)
    .await?;

    Ok(pool)
}
