package xyz.ghola.app.ml

import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query

/**
 * One reverse-summarized `(intent, email)` pair derived from the user's
 * sent folder, used as training data for the per-user LoRA fine-tune
 * ([PersonalFineTuneWorker]).
 *
 * **Schema decisions worth knowing:**
 *  - PK is the source `sent_email.id` (Gmail message id). Natural dedup —
 *    re-running [TrainingPairGenerator] on an already-processed corpus is
 *    a no-op for existing rows.
 *  - `baseModelHash` invalidates intents when the base model changes:
 *    different base models tokenize differently, so an "intent" reverse-
 *    summarized by the old model may not match the writing style well
 *    enough for the new model to train on.
 *  - `split` is decided once (90/10 seeded shuffle in
 *    [TrainingPairGenerator]) and persisted, so re-runs honor the same
 *    train/val partition — the validation set NEVER shifts into training.
 */
@Entity(tableName = "training_pair")
data class TrainingPair(
    @PrimaryKey
    @ColumnInfo(name = "sent_email_id") val sentEmailId: String,
    @ColumnInfo(name = "intent") val intent: String,
    @ColumnInfo(name = "email") val email: String,
    @ColumnInfo(name = "generated_at") val generatedAt: Long,
    @ColumnInfo(name = "base_model_hash") val baseModelHash: String,
    @ColumnInfo(name = "intent_token_len") val intentTokenLen: Int,
    @ColumnInfo(name = "email_token_len") val emailTokenLen: Int,
    /** "train" | "val" — assigned deterministically by a seeded shuffle. */
    @ColumnInfo(name = "split") val split: String,
)

@Dao
interface TrainingPairDao {

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(pair: TrainingPair)

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun upsertAllSkipExisting(pairs: List<TrainingPair>)

    @Query("SELECT * FROM training_pair")
    suspend fun all(): List<TrainingPair>

    @Query("SELECT * FROM training_pair WHERE split = :split")
    suspend fun bySplit(split: String): List<TrainingPair>

    @Query("SELECT sent_email_id FROM training_pair")
    suspend fun existingIds(): List<String>

    @Query("SELECT COUNT(*) FROM training_pair")
    suspend fun count(): Int

    @Query("SELECT COUNT(*) FROM training_pair WHERE split = :split")
    suspend fun countBySplit(split: String): Int

    @Query("DELETE FROM training_pair")
    suspend fun deleteAll()

    @Query("DELETE FROM training_pair WHERE base_model_hash != :currentHash")
    suspend fun invalidateOtherHashes(currentHash: String): Int
}
