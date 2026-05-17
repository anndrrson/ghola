package xyz.ghola.app.ml

import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query

/**
 * One user judgment from the [xyz.ghola.app.ui.VoiceCompareActivity] A/B
 * panel. We persist these so:
 *   1. Future fine-tune runs can use them as preference data (DPO-style
 *      reward signal — v0.7).
 *   2. The pitch deck can cite "users preferred the LoRA output X% of the
 *      time" without having to run a fresh study.
 *
 * Anti-bias notes:
 *   - `baseOnLeft` records which side carried which output. Labels in the
 *     UI are A/B — the user doesn't see "base" vs "lora" until after they
 *     pick — so any left/right preference bias washes out across rounds.
 *   - `prompt` is the user's exact prompt so we can replay a round.
 */
@Entity(tableName = "voice_preference")
data class VoicePreference(
    @PrimaryKey(autoGenerate = true)
    @ColumnInfo(name = "id") val id: Long = 0,
    @ColumnInfo(name = "prompt") val prompt: String,
    @ColumnInfo(name = "base_output") val baseOutput: String,
    @ColumnInfo(name = "lora_output") val loraOutput: String,
    /** "BASE" | "LORA" | "TIE" */
    @ColumnInfo(name = "chosen") val chosen: String,
    @ColumnInfo(name = "base_on_left") val baseOnLeft: Boolean,
    @ColumnInfo(name = "created_at") val createdAt: Long,
    /** Cached cosine scores at write time; null if VoiceMetric wasn't available. */
    @ColumnInfo(name = "base_score") val baseScore: Float?,
    @ColumnInfo(name = "lora_score") val loraScore: Float?,
)

@Dao
interface VoicePreferenceDao {

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insert(pref: VoicePreference): Long

    @Query("SELECT * FROM voice_preference ORDER BY created_at DESC")
    suspend fun all(): List<VoicePreference>

    @Query("SELECT COUNT(*) FROM voice_preference")
    suspend fun count(): Int

    @Query("SELECT COUNT(*) FROM voice_preference WHERE chosen = :which")
    suspend fun countChosen(which: String): Int

    @Query("DELETE FROM voice_preference")
    suspend fun deleteAll()
}
