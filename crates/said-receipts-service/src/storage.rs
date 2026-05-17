//! Storage trait + Postgres + in-memory implementations.
//!
//! The trait keeps the HTTP and batcher code DB-agnostic so the test
//! suite can run against a synchronous in-memory store without needing
//! a live Postgres. The production binary uses `PgStore`.

use std::collections::HashMap;
use std::sync::Mutex;

use async_trait::async_trait;
use serde_json::Value;

#[derive(Debug, Clone)]
pub struct PendingReceipt {
    pub id: i64,
    pub receipt_hash: [u8; 32],
    pub created_at_unix: i64,
}

#[derive(Debug, Clone)]
pub struct AnchoredReceipt {
    pub leaf_index: i32,
    pub batch: Batch,
}

#[derive(Debug, Clone)]
pub struct Batch {
    pub id: i64,
    pub root: [u8; 32],
    pub count: i32,
    pub period_start_unix: i64,
    pub period_end_unix: i64,
    pub published_at_unix: Option<i64>,
    pub solana_signature: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ReceiptLookup {
    pub id: i64,
    pub receipt_hash: [u8; 32],
    pub batch_id: Option<i64>,
    pub leaf_index: Option<i32>,
    pub created_at_unix: i64,
}

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("not found")]
    NotFound,
    #[error("database error: {0}")]
    Db(String),
}

/// Async storage abstraction used by `routes` and `batch`.
#[async_trait]
pub trait ReceiptsStore: Send + Sync + 'static {
    async fn insert_receipt(
        &self,
        receipt_hash: [u8; 32],
        body: &Value,
    ) -> Result<(), StorageError>;

    async fn lookup_receipt(
        &self,
        receipt_hash: [u8; 32],
    ) -> Result<Option<ReceiptLookup>, StorageError>;

    async fn batch_for_id(&self, batch_id: i64) -> Result<Batch, StorageError>;

    /// Drain up to `limit` pending receipts and assign them to a new
    /// batch with the given Merkle root. Returns the inserted batch
    /// (with `id`) plus the ordered list of (receipt_id, leaf_index).
    async fn assign_batch(
        &self,
        root: [u8; 32],
        leaves: &[PendingReceipt],
    ) -> Result<Batch, StorageError>;

    async fn list_pending(&self, limit: i32) -> Result<Vec<PendingReceipt>, StorageError>;

    async fn list_unpublished_batches(&self) -> Result<Vec<Batch>, StorageError>;

    async fn mark_batch_published(
        &self,
        batch_id: i64,
        solana_signature: &str,
        published_at_unix: i64,
    ) -> Result<(), StorageError>;

    /// Look up a batch's leaves in original (id-sorted) order. Needed
    /// to rebuild the Merkle tree at proof-read time without trusting
    /// the in-memory cache.
    async fn leaves_for_batch(&self, batch_id: i64) -> Result<Vec<[u8; 32]>, StorageError>;
}

// -----------------------------------------------------------------
// In-memory store, used by the integration tests.
// -----------------------------------------------------------------

#[derive(Default)]
pub struct MemoryStore {
    inner: Mutex<MemoryInner>,
}

#[derive(Default)]
struct MemoryInner {
    next_receipt_id: i64,
    next_batch_id: i64,
    receipts: Vec<MemoryReceipt>,
    batches: HashMap<i64, Batch>,
}

#[derive(Clone)]
struct MemoryReceipt {
    id: i64,
    receipt_hash: [u8; 32],
    batch_id: Option<i64>,
    leaf_index: Option<i32>,
    created_at_unix: i64,
}

impl MemoryStore {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait]
impl ReceiptsStore for MemoryStore {
    async fn insert_receipt(
        &self,
        receipt_hash: [u8; 32],
        _body: &Value,
    ) -> Result<(), StorageError> {
        let mut g = self.inner.lock().unwrap();
        if g.receipts.iter().any(|r| r.receipt_hash == receipt_hash) {
            return Ok(());
        }
        g.next_receipt_id += 1;
        let id = g.next_receipt_id;
        let now = chrono::Utc::now().timestamp();
        g.receipts.push(MemoryReceipt {
            id,
            receipt_hash,
            batch_id: None,
            leaf_index: None,
            created_at_unix: now,
        });
        Ok(())
    }

    async fn lookup_receipt(
        &self,
        receipt_hash: [u8; 32],
    ) -> Result<Option<ReceiptLookup>, StorageError> {
        let g = self.inner.lock().unwrap();
        Ok(g.receipts
            .iter()
            .find(|r| r.receipt_hash == receipt_hash)
            .map(|r| ReceiptLookup {
                id: r.id,
                receipt_hash: r.receipt_hash,
                batch_id: r.batch_id,
                leaf_index: r.leaf_index,
                created_at_unix: r.created_at_unix,
            }))
    }

    async fn batch_for_id(&self, batch_id: i64) -> Result<Batch, StorageError> {
        let g = self.inner.lock().unwrap();
        g.batches
            .get(&batch_id)
            .cloned()
            .ok_or(StorageError::NotFound)
    }

    async fn assign_batch(
        &self,
        root: [u8; 32],
        leaves: &[PendingReceipt],
    ) -> Result<Batch, StorageError> {
        if leaves.is_empty() {
            return Err(StorageError::Db("empty batch".into()));
        }
        let mut g = self.inner.lock().unwrap();
        g.next_batch_id += 1;
        let id = g.next_batch_id;
        let period_start = leaves.iter().map(|l| l.created_at_unix).min().unwrap();
        let period_end_raw = leaves.iter().map(|l| l.created_at_unix).max().unwrap();
        // The on-chain program requires period_end > period_start. A batch
        // built within a single second (single receipt, or many receipts
        // landing inside one Postgres NOW() tick) would otherwise be
        // rejected. Bump by 1s so the bracket is always strictly positive.
        let period_end = if period_end_raw > period_start {
            period_end_raw
        } else {
            period_start + 1
        };
        let batch = Batch {
            id,
            root,
            count: leaves.len() as i32,
            period_start_unix: period_start,
            period_end_unix: period_end,
            published_at_unix: None,
            solana_signature: None,
        };
        g.batches.insert(id, batch.clone());
        for (idx, l) in leaves.iter().enumerate() {
            if let Some(r) = g.receipts.iter_mut().find(|r| r.id == l.id) {
                r.batch_id = Some(id);
                r.leaf_index = Some(idx as i32);
            }
        }
        Ok(batch)
    }

    async fn list_pending(&self, limit: i32) -> Result<Vec<PendingReceipt>, StorageError> {
        let g = self.inner.lock().unwrap();
        let mut out: Vec<_> = g
            .receipts
            .iter()
            .filter(|r| r.batch_id.is_none())
            .map(|r| PendingReceipt {
                id: r.id,
                receipt_hash: r.receipt_hash,
                created_at_unix: r.created_at_unix,
            })
            .collect();
        out.sort_by_key(|r| r.id);
        out.truncate(limit as usize);
        Ok(out)
    }

    async fn list_unpublished_batches(&self) -> Result<Vec<Batch>, StorageError> {
        let g = self.inner.lock().unwrap();
        let mut out: Vec<_> = g
            .batches
            .values()
            .filter(|b| b.solana_signature.is_none())
            .cloned()
            .collect();
        out.sort_by_key(|b| b.id);
        Ok(out)
    }

    async fn mark_batch_published(
        &self,
        batch_id: i64,
        sig: &str,
        published_at_unix: i64,
    ) -> Result<(), StorageError> {
        let mut g = self.inner.lock().unwrap();
        let b = g.batches.get_mut(&batch_id).ok_or(StorageError::NotFound)?;
        b.solana_signature = Some(sig.to_string());
        b.published_at_unix = Some(published_at_unix);
        Ok(())
    }

    async fn leaves_for_batch(&self, batch_id: i64) -> Result<Vec<[u8; 32]>, StorageError> {
        let g = self.inner.lock().unwrap();
        let mut rows: Vec<_> = g
            .receipts
            .iter()
            .filter(|r| r.batch_id == Some(batch_id))
            .cloned()
            .collect();
        rows.sort_by_key(|r| r.leaf_index.unwrap_or(0));
        Ok(rows.iter().map(|r| r.receipt_hash).collect())
    }
}

// -----------------------------------------------------------------
// Postgres-backed store. Behind a runtime check rather than a feature
// flag so the lib still compiles with sqlx in scope.
// -----------------------------------------------------------------

pub struct PgStore {
    pool: sqlx::PgPool,
}

impl PgStore {
    pub fn new(pool: sqlx::PgPool) -> Self {
        Self { pool }
    }
}

fn map_sqlx(e: sqlx::Error) -> StorageError {
    StorageError::Db(e.to_string())
}

#[async_trait]
impl ReceiptsStore for PgStore {
    async fn insert_receipt(
        &self,
        receipt_hash: [u8; 32],
        body: &Value,
    ) -> Result<(), StorageError> {
        // ON CONFLICT DO NOTHING: duplicate submissions of the same
        // receipt collapse silently rather than 500'ing.
        sqlx::query(
            "INSERT INTO receipts (receipt_hash, body) VALUES ($1, $2) \
             ON CONFLICT (receipt_hash) DO NOTHING",
        )
        .bind(&receipt_hash[..])
        .bind(body)
        .execute(&self.pool)
        .await
        .map_err(map_sqlx)?;
        Ok(())
    }

    async fn lookup_receipt(
        &self,
        receipt_hash: [u8; 32],
    ) -> Result<Option<ReceiptLookup>, StorageError> {
        let row: Option<(i64, Vec<u8>, Option<i64>, Option<i32>, i64)> = sqlx::query_as(
            "SELECT id, receipt_hash, batch_id, leaf_index, created_at_unix \
             FROM receipts WHERE receipt_hash = $1",
        )
        .bind(&receipt_hash[..])
        .fetch_optional(&self.pool)
        .await
        .map_err(map_sqlx)?;

        Ok(row.map(|(id, hash, batch_id, leaf_index, created_at_unix)| {
            let mut h = [0u8; 32];
            h.copy_from_slice(&hash[..32]);
            ReceiptLookup {
                id,
                receipt_hash: h,
                batch_id,
                leaf_index,
                created_at_unix,
            }
        }))
    }

    async fn batch_for_id(&self, batch_id: i64) -> Result<Batch, StorageError> {
        let row: (i64, Vec<u8>, i32, i64, i64, Option<i64>, Option<String>) = sqlx::query_as(
            "SELECT id, root, count, period_start_unix, period_end_unix, \
                    published_at_unix, solana_signature \
             FROM batches WHERE id = $1",
        )
        .bind(batch_id)
        .fetch_one(&self.pool)
        .await
        .map_err(map_sqlx)?;

        let mut root = [0u8; 32];
        root.copy_from_slice(&row.1[..32]);
        Ok(Batch {
            id: row.0,
            root,
            count: row.2,
            period_start_unix: row.3,
            period_end_unix: row.4,
            published_at_unix: row.5,
            solana_signature: row.6,
        })
    }

    async fn assign_batch(
        &self,
        root: [u8; 32],
        leaves: &[PendingReceipt],
    ) -> Result<Batch, StorageError> {
        if leaves.is_empty() {
            return Err(StorageError::Db("empty batch".into()));
        }
        let period_start = leaves.iter().map(|l| l.created_at_unix).min().unwrap();
        let period_end_raw = leaves.iter().map(|l| l.created_at_unix).max().unwrap();
        // The on-chain program requires period_end > period_start. A batch
        // built within a single second (single receipt, or many receipts
        // landing inside one Postgres NOW() tick) would otherwise be
        // rejected. Bump by 1s so the bracket is always strictly positive.
        let period_end = if period_end_raw > period_start {
            period_end_raw
        } else {
            period_start + 1
        };
        let count = leaves.len() as i32;

        let mut tx = self.pool.begin().await.map_err(map_sqlx)?;

        // Insert batch row, returning id.
        let (batch_id,): (i64,) = sqlx::query_as(
            "INSERT INTO batches (root, count, period_start_unix, period_end_unix) \
             VALUES ($1, $2, $3, $4) RETURNING id",
        )
        .bind(&root[..])
        .bind(count)
        .bind(period_start)
        .bind(period_end)
        .fetch_one(&mut *tx)
        .await
        .map_err(map_sqlx)?;

        for (idx, l) in leaves.iter().enumerate() {
            sqlx::query(
                "UPDATE receipts SET batch_id = $1, leaf_index = $2 WHERE id = $3",
            )
            .bind(batch_id)
            .bind(idx as i32)
            .bind(l.id)
            .execute(&mut *tx)
            .await
            .map_err(map_sqlx)?;
        }

        tx.commit().await.map_err(map_sqlx)?;

        Ok(Batch {
            id: batch_id,
            root,
            count,
            period_start_unix: period_start,
            period_end_unix: period_end,
            published_at_unix: None,
            solana_signature: None,
        })
    }

    async fn list_pending(&self, limit: i32) -> Result<Vec<PendingReceipt>, StorageError> {
        let rows: Vec<(i64, Vec<u8>, i64)> = sqlx::query_as(
            "SELECT id, receipt_hash, created_at_unix FROM receipts \
             WHERE batch_id IS NULL ORDER BY id LIMIT $1",
        )
        .bind(limit as i64)
        .fetch_all(&self.pool)
        .await
        .map_err(map_sqlx)?;

        Ok(rows
            .into_iter()
            .map(|(id, hash, t)| {
                let mut h = [0u8; 32];
                h.copy_from_slice(&hash[..32]);
                PendingReceipt {
                    id,
                    receipt_hash: h,
                    created_at_unix: t,
                }
            })
            .collect())
    }

    async fn list_unpublished_batches(&self) -> Result<Vec<Batch>, StorageError> {
        let rows: Vec<(i64, Vec<u8>, i32, i64, i64, Option<i64>, Option<String>)> = sqlx::query_as(
            "SELECT id, root, count, period_start_unix, period_end_unix, \
                    published_at_unix, solana_signature \
             FROM batches WHERE solana_signature IS NULL ORDER BY id",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(map_sqlx)?;

        Ok(rows
            .into_iter()
            .map(|(id, root, count, ps, pe, pa, sig)| {
                let mut r = [0u8; 32];
                r.copy_from_slice(&root[..32]);
                Batch {
                    id,
                    root: r,
                    count,
                    period_start_unix: ps,
                    period_end_unix: pe,
                    published_at_unix: pa,
                    solana_signature: sig,
                }
            })
            .collect())
    }

    async fn mark_batch_published(
        &self,
        batch_id: i64,
        sig: &str,
        published_at_unix: i64,
    ) -> Result<(), StorageError> {
        sqlx::query(
            "UPDATE batches SET solana_signature = $1, published_at_unix = $2 WHERE id = $3",
        )
        .bind(sig)
        .bind(published_at_unix)
        .bind(batch_id)
        .execute(&self.pool)
        .await
        .map_err(map_sqlx)?;
        Ok(())
    }

    async fn leaves_for_batch(&self, batch_id: i64) -> Result<Vec<[u8; 32]>, StorageError> {
        let rows: Vec<(Vec<u8>,)> = sqlx::query_as(
            "SELECT receipt_hash FROM receipts \
             WHERE batch_id = $1 ORDER BY leaf_index",
        )
        .bind(batch_id)
        .fetch_all(&self.pool)
        .await
        .map_err(map_sqlx)?;

        Ok(rows
            .into_iter()
            .map(|(hash,)| {
                let mut h = [0u8; 32];
                h.copy_from_slice(&hash[..32]);
                h
            })
            .collect())
    }
}
