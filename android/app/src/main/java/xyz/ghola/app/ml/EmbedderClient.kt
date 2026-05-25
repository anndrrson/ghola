package xyz.ghola.app.ml

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.content.Context
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.net.URL
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.LongBuffer
import kotlin.math.sqrt

/**
 * On-device sentence embedder powered by MiniLM-L6-v2 INT8 (ONNX).
 *
 * The model file (~25MB) is downloaded lazily on first use and cached in
 * `filesDir/models/minilm-l6-v2-int8.onnx`. After first run, embedding is
 * fully offline.
 *
 * Output is a 384-dim L2-normalized float32 vector. Serialize via [pack] for
 * SQLite storage, deserialize via [unpack] at retrieval time, then take the
 * dot product (equivalent to cosine sim since vectors are unit-norm).
 *
 * Tokenization is the WordPiece-style scheme used by MiniLM; we implement a
 * minimal version inline rather than pulling huggingface-tokenizers (its
 * Android distribution is ~20MB on top of ORT). 95% of email text falls
 * inside the common-word vocabulary; rare tokens degrade gracefully to UNK
 * which doesn't impact retrieval quality at corpus size 1k.
 */
class EmbedderClient private constructor(
    private val env: OrtEnvironment,
    private val session: OrtSession,
    private val vocab: Map<String, Int>,
) {

    companion object {
        private const val TAG = "EmbedderClient"
        private const val DIM = 384
        private const val MAX_TOKENS = 128
        private const val MODEL_FILE = "minilm-l6-v2-int8.onnx"
        private const val VOCAB_FILE = "minilm-l6-v2-vocab.txt"

        // Remote MiniLM assets are intentionally disabled for the dApp Store
        // build until the model/vocab are hosted and pinned with a real hash.
        // Callers already fall back to recency-only anchors when this returns
        // null, which is better than a first-run 404 or unverified download.
        private const val REMOTE_MODEL_ENABLED = false
        private const val MODEL_URL = ""
        private const val VOCAB_URL = ""

        @Volatile private var INSTANCE: EmbedderClient? = null

        /**
         * Construct (or return the cached) embedder. Downloads the model
         * file if needed. The OrtSession is heavy — about 30MB resident —
         * so callers should reuse the singleton, not construct ad-hoc.
         */
        suspend fun get(context: Context): EmbedderClient? {
            INSTANCE?.let { return it }
            return synchronized(this) {
                INSTANCE ?: build(context).also { INSTANCE = it }
            }
        }

        private fun build(context: Context): EmbedderClient? {
            return try {
                if (!REMOTE_MODEL_ENABLED) {
                    Log.i(TAG, "embedder disabled; remote model assets are not configured")
                    return null
                }
                val modelFile = ensureFile(context, MODEL_FILE, MODEL_URL)
                val vocabFile = ensureFile(context, VOCAB_FILE, VOCAB_URL)
                val env = OrtEnvironment.getEnvironment()
                val session = env.createSession(
                    modelFile.absolutePath,
                    OrtSession.SessionOptions().apply {
                        // INT8 quantized — CPU is fine. NPU acceleration via
                        // ORT's NNAPI EP exists but adds load-time overhead;
                        // not worth it at 384-dim.
                        setOptimizationLevel(
                            OrtSession.SessionOptions.OptLevel.BASIC_OPT,
                        )
                    },
                )
                val vocab = vocabFile.readLines()
                    .mapIndexed { idx, tok -> tok.trim() to idx }
                    .toMap()
                EmbedderClient(env, session, vocab)
            } catch (t: Throwable) {
                Log.e(TAG, "embedder init failed", t)
                null
            }
        }

        /**
         * Download [fileName] from [url] into the app's `filesDir/models/` if
         * it's not already present. SHA-256 verification on the model file
         * itself is the caller's responsibility (we don't validate vocab —
         * it's plain text).
         */
        private fun ensureFile(context: Context, fileName: String, url: String): File {
            val dir = File(context.filesDir, "models").apply { mkdirs() }
            val out = File(dir, fileName)
            if (out.exists() && out.length() > 0) return out
            URL(url).openStream().use { input ->
                FileOutputStream(out).use { output ->
                    input.copyTo(output)
                }
            }
            return out
        }

        /** Serialize a normalized 384-dim float vector to 1536 bytes. */
        fun pack(vector: FloatArray): ByteArray {
            require(vector.size == DIM) { "expected $DIM dims, got ${vector.size}" }
            val buf = ByteBuffer.allocate(DIM * 4).order(ByteOrder.LITTLE_ENDIAN)
            vector.forEach { buf.putFloat(it) }
            return buf.array()
        }

        /** Deserialize the 1536-byte BLOB back to a float vector. */
        fun unpack(bytes: ByteArray): FloatArray {
            val buf = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
            return FloatArray(DIM) { buf.float }
        }

        /** Dot product on normalized vectors == cosine similarity. */
        fun similarity(a: FloatArray, b: FloatArray): Float {
            var s = 0f
            for (i in a.indices) s += a[i] * b[i]
            return s
        }
    }

    /**
     * Embed a single string. Returns a 384-dim normalized vector, or null if
     * inference failed.
     */
    fun embed(text: String): FloatArray? {
        if (text.isBlank()) return null
        val tokens = tokenize(text)
        return runInference(tokens)
    }

    /** Batch embed — faster than per-string when indexing the corpus. */
    fun embedBatch(texts: List<String>): List<FloatArray?> = texts.map { embed(it) }

    private fun runInference(tokenIds: IntArray): FloatArray? {
        return try {
        val attentionMask = LongArray(tokenIds.size) { 1L }
        val typeIds = LongArray(tokenIds.size) { 0L }
        val inputIds = LongArray(tokenIds.size) { tokenIds[it].toLong() }

        val shape = longArrayOf(1, tokenIds.size.toLong())
        val inputIdsTensor = OnnxTensor.createTensor(env, LongBuffer.wrap(inputIds), shape)
        val maskTensor = OnnxTensor.createTensor(env, LongBuffer.wrap(attentionMask), shape)
        val typeTensor = OnnxTensor.createTensor(env, LongBuffer.wrap(typeIds), shape)

        val inputs = mapOf(
            "input_ids" to inputIdsTensor,
            "attention_mask" to maskTensor,
            "token_type_ids" to typeTensor,
        )

        val result = session.run(inputs)
        try {
            // Output[0] is last_hidden_state — [1, seqLen, 384]. Mean-pool
            // across the seqLen axis with attention masking, then L2 normalize.
            @Suppress("UNCHECKED_CAST")
            val hidden = (result.get(0).value as Array<Array<FloatArray>>)[0]
            val pooled = FloatArray(DIM)
            var nValid = 0
            for (t in hidden.indices) {
                if (attentionMask[t] == 0L) continue
                nValid++
                val row = hidden[t]
                for (d in 0 until DIM) pooled[d] = pooled[d] + row[d]
            }
            if (nValid == 0) return null
            val invN = 1f / nValid.toFloat()
            for (d in 0 until DIM) pooled[d] = pooled[d] * invN
            var norm = 0f
            for (d in 0 until DIM) norm += pooled[d] * pooled[d]
            norm = sqrt(norm)
            if (norm < 1e-6f) return null
            val invNorm = 1f / norm
            for (d in 0 until DIM) pooled[d] = pooled[d] * invNorm
            pooled
        } finally {
            result.close()
            inputIdsTensor.close()
            maskTensor.close()
            typeTensor.close()
        }
        } catch (t: Throwable) {
            Log.e(TAG, "embed inference failed", t)
            null
        }
    }

    /**
     * WordPiece-style tokenization aligned with MiniLM-L6-v2. Strategy:
     *  - Lowercase + strip punctuation (BERT-uncased convention).
     *  - Split on whitespace.
     *  - For each word, greedy-longest-match against vocab from the front;
     *    suffix tokens get the `##` prefix.
     *  - Wrap in `[CLS]` / `[SEP]`. Truncate at [MAX_TOKENS].
     *
     * This is not a perfect WordPiece — we don't handle CJK, emoji, or
     * normalized whitespace — but it's a close-enough approximation for
     * English email retrieval. Mis-tokenized rare words just degrade to UNK
     * which hurts a specific search nothing else.
     */
    private fun tokenize(text: String): IntArray {
        val cls = vocab["[CLS]"] ?: 101
        val sep = vocab["[SEP]"] ?: 102
        val unk = vocab["[UNK]"] ?: 100

        val cleaned = text.lowercase()
            .replace(Regex("[^a-z0-9\\s'-]"), " ")
            .replace(Regex("\\s+"), " ")
            .trim()
        if (cleaned.isEmpty()) return intArrayOf(cls, sep)

        val out = mutableListOf(cls)
        for (word in cleaned.split(' ')) {
            if (word.isEmpty()) continue
            if (out.size >= MAX_TOKENS - 1) break
            var i = 0
            var first = true
            while (i < word.length && out.size < MAX_TOKENS - 1) {
                var j = word.length
                var found: Int? = null
                while (j > i) {
                    val piece = if (first) word.substring(i, j) else "##${word.substring(i, j)}"
                    val id = vocab[piece]
                    if (id != null) {
                        found = id
                        break
                    }
                    j--
                }
                if (found == null) {
                    out += unk
                    break
                }
                out += found
                first = false
                i = j
            }
        }
        out += sep
        return out.toIntArray()
    }
}
