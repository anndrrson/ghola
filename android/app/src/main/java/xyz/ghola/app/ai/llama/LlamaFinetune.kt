package xyz.ghola.app.ai.llama

import android.util.Log

/**
 * On-device LoRA fine-tune entrypoint.
 *
 * Wraps llama.cpp's training path (see `examples/training/finetune.cpp` in
 * the vendored llama.cpp tree, fetched at the tag pinned in
 * `app/src/main/cpp/CMakeLists.txt`). The training executor runs in the
 * JNI thread; progress is reported via [ProgressCallback] so the caller —
 * [xyz.ghola.app.ml.PersonalFineTuneWorker] — can push notifications and
 * service the foreground notification's progress bar.
 *
 * Wall-clock budget on a Dimensity 9300 (the Seeker's SoC):
 *   500 emails × ~80 prompt + ~250 completion tokens × 3 epochs
 *   ≈ 495k training tokens × CPU-only training path (NPU isn't usable for
 *     training; Mali Vulkan training is too unstable to ship in v0.6)
 *   ≈ 1.0-1.7 hours.
 *
 * Cancellation is cooperative: [cancel] flips an atomic flag that the C++
 * training loop checks between optimizer steps. A cancelled run leaves no
 * partial adapter on disk; callers can re-run with the same hyperparams.
 *
 * **Implementation status as of v0.6.0**: the API is wired through to a
 * JNI entrypoint that returns `JNI_FALSE` with a "not implemented yet"
 * progress callback. The port of llama.cpp's `finetune.cpp` `main()` into
 * a callable function is the next step — tracked at
 * `cpp/llama_finetune_jni.cpp` with a `// TODO(v0.6 P3.2)` marker for
 * where the optimizer loop slots in. Until that lands,
 * [PersonalFineTuneWorker] surfaces "voice training engine pending" in
 * the notification.
 */
class LlamaFinetune {

    companion object {
        private const val TAG = "LlamaFinetune"

        init {
            // Same .so the inference path loads; the v0.6 build links the
            // training translation unit (`llama_finetune_jni.cpp`) into
            // `libthumper_llama.so` alongside `llama_jni.cpp`.
            System.loadLibrary("thumper_llama")
        }
    }

    /**
     * LoRA hyperparameters. Defaults are tuned for ~500 emails of training
     * data and a 1.5B-class base model — enough capacity to capture writing
     * voice without memorizing entire emails verbatim (the n-gram-leakage
     * canary in `VoiceMetric` will flag if rank/epochs are too aggressive).
     */
    data class Hyperparams(
        val rank: Int = 16,
        val alpha: Float = 32f,
        val learningRate: Float = 3e-4f,
        val epochs: Int = 3,
        val batchSize: Int = 1,
        val ctxLen: Int = 1024,
        /**
         * Which projection matrices to attach LoRA to.
         *
         * **v0.6 NOTE — IGNORED BY THE NATIVE TRAINER.** The C++ JNI
         * hardcodes the QKV+O attention set (attn_q.weight, attn_k.weight,
         * attn_v.weight, attn_output.weight × 28 layers = 112 modules).
         * This field is kept for API stability + v0.7 forward-compat when
         * MLP-target LoRA lands.
         *
         * To actually change the target set today: edit `target_names` in
         * `llama_finetune_jni.cpp`'s Java_..._run() handler.
         */
        val targetModules: List<String> = listOf("q_proj", "k_proj", "v_proj", "o_proj"),
    )

    interface ProgressCallback {
        fun onEpoch(epoch: Int, totalEpochs: Int, lossSoFar: Float)
        fun onStep(step: Int, totalSteps: Int, loss: Float)
        fun onComplete(adapterPath: String)
        fun onError(message: String)
    }

    /**
     * Run a LoRA fine-tune.
     *
     * @param modelPath  base GGUF (Qwen 2.5 1.5B q8_0 per v0.6 [ModelManager])
     * @param jsonlPath  newline-delimited JSON: {"prompt":..., "completion":...}
     *                   — written by `TrainingPairGenerator` from the train
     *                   split of `training_pair`
     * @param outLoraPath where the adapter is written on success
     * @param progress callback for foreground notification updates
     * @param hyper hyperparams (defaults tuned for our corpus size)
     * @return true on success (adapter written), false otherwise.
     *         On false, callbacks have already surfaced the failure reason.
     */
    external fun run(
        modelPath: String,
        jsonlPath: String,
        outLoraPath: String,
        progress: ProgressCallback,
        hyper: Hyperparams,
    ): Boolean

    /**
     * Cooperative cancel. Idempotent. Safe to call from any thread. After
     * cancellation, [run] returns false and `onError("cancelled")` fires.
     */
    external fun cancel()
}
