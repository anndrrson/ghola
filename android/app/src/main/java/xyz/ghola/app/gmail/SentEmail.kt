package xyz.ghola.app.gmail

import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.TypeConverter
import androidx.room.TypeConverters
import android.content.Context

/**
 * Local mirror of a single sent email. The `embedding` column is a 384-dim
 * float32 vector serialized as a raw byte array (1536 bytes) for brute-force
 * cosine-sim retrieval at draft time. We do not use a vector index — at
 * 1k rows the linear scan is sub-50ms on the Seeker CPU and the simplicity
 * is worth more than the lookup speedup an HNSW index would provide.
 */
@Entity(tableName = "sent_email")
@TypeConverters(StringListConverter::class)
data class SentEmail(
    @PrimaryKey
    @ColumnInfo(name = "id") val id: String,
    @ColumnInfo(name = "thread_id") val threadId: String,
    @ColumnInfo(name = "to_addresses") val toAddresses: List<String>,
    @ColumnInfo(name = "cc_addresses") val ccAddresses: List<String> = emptyList(),
    @ColumnInfo(name = "subject") val subject: String,
    @ColumnInfo(name = "body_text") val bodyText: String,
    @ColumnInfo(name = "sent_at") val sentAt: Long,
    @ColumnInfo(name = "embedding", typeAffinity = ColumnInfo.BLOB)
    val embedding: ByteArray? = null,
) {
    // Room generates `equals`/`hashCode` from the primary key only; we
    // override here so blob comparison doesn't fire on hot paths. The
    // primary-key equality matches the rest of the schema's intent.
    override fun equals(other: Any?): Boolean = other is SentEmail && other.id == id
    override fun hashCode(): Int = id.hashCode()
}

class StringListConverter {
    @TypeConverter
    fun fromList(value: List<String>): String = value.joinToString("")

    @TypeConverter
    fun toList(value: String): List<String> =
        if (value.isEmpty()) emptyList() else value.split('')
}

@Dao
interface SentEmailDao {

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(email: SentEmail)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertAll(emails: List<SentEmail>)

    @Query("SELECT * FROM sent_email WHERE id = :id")
    suspend fun get(id: String): SentEmail?

    @Query("SELECT id FROM sent_email WHERE id IN (:ids)")
    suspend fun existingIds(ids: List<String>): List<String>

    @Query("SELECT * FROM sent_email ORDER BY sent_at DESC LIMIT :limit")
    suspend fun recent(limit: Int): List<SentEmail>

    @Query("SELECT * FROM sent_email WHERE embedding IS NOT NULL ORDER BY sent_at DESC LIMIT :limit")
    suspend fun embeddedRecent(limit: Int): List<SentEmail>

    @Query("SELECT * FROM sent_email WHERE embedding IS NULL ORDER BY sent_at DESC LIMIT :limit")
    suspend fun unembedded(limit: Int = 50): List<SentEmail>

    @Query("UPDATE sent_email SET embedding = :embedding WHERE id = :id")
    suspend fun setEmbedding(id: String, embedding: ByteArray)

    @Query("SELECT COUNT(*) FROM sent_email")
    suspend fun count(): Int

    @Query("SELECT MAX(sent_at) FROM sent_email")
    suspend fun latestSentAt(): Long?
}

@Database(
    entities = [
        SentEmail::class,
        xyz.ghola.app.ml.TrainingPair::class,
        xyz.ghola.app.ml.VoicePreference::class,
    ],
    version = 3,
    exportSchema = false,
)
@TypeConverters(StringListConverter::class)
abstract class GholaMailDatabase : RoomDatabase() {
    abstract fun sentEmailDao(): SentEmailDao
    abstract fun trainingPairDao(): xyz.ghola.app.ml.TrainingPairDao
    abstract fun voicePreferenceDao(): xyz.ghola.app.ml.VoicePreferenceDao

    companion object {
        @Volatile private var INSTANCE: GholaMailDatabase? = null

        /**
         * v0.5 → v0.6 migration. Additive: adds the `training_pair` table
         * for [xyz.ghola.app.ml.TrainingPairGenerator]. Does NOT touch
         * `sent_email` — the user's mirror is sacrosanct because it can't
         * be recovered without re-running Gmail OAuth + the bandwidth +
         * battery cost of a full mirror pass.
         */
        private val MIGRATION_1_2 = object : androidx.room.migration.Migration(1, 2) {
            override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
                db.execSQL(
                    """
                    CREATE TABLE IF NOT EXISTS training_pair (
                        sent_email_id TEXT NOT NULL PRIMARY KEY,
                        intent TEXT NOT NULL,
                        email TEXT NOT NULL,
                        generated_at INTEGER NOT NULL,
                        base_model_hash TEXT NOT NULL,
                        intent_token_len INTEGER NOT NULL,
                        email_token_len INTEGER NOT NULL,
                        split TEXT NOT NULL
                    )
                    """.trimIndent(),
                )
            }
        }

        /**
         * v0.6 P9 migration: voice_preference for the A/B compare panel.
         * Like MIGRATION_1_2 this is additive — never touches existing
         * tables.
         */
        private val MIGRATION_2_3 = object : androidx.room.migration.Migration(2, 3) {
            override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
                db.execSQL(
                    """
                    CREATE TABLE IF NOT EXISTS voice_preference (
                        id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                        prompt TEXT NOT NULL,
                        base_output TEXT NOT NULL,
                        lora_output TEXT NOT NULL,
                        chosen TEXT NOT NULL,
                        base_on_left INTEGER NOT NULL,
                        created_at INTEGER NOT NULL,
                        base_score REAL,
                        lora_score REAL
                    )
                    """.trimIndent(),
                )
            }
        }

        fun get(context: Context): GholaMailDatabase {
            return INSTANCE ?: synchronized(this) {
                INSTANCE ?: Room.databaseBuilder(
                    context.applicationContext,
                    GholaMailDatabase::class.java,
                    "ghola_mail.db",
                )
                    // v0.6: explicit migration — do NOT
                    // fallbackToDestructiveMigration here. The mirror is the
                    // load-bearing dataset for everything voice-related; we
                    // can't afford to wipe it on a schema bump.
                    .addMigrations(MIGRATION_1_2, MIGRATION_2_3)
                    .build()
                    .also { INSTANCE = it }
            }
        }
    }
}
