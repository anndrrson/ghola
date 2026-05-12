// LoRA fine-tune JNI entrypoint.
//
// The full implementation ports llama.cpp's `examples/training/finetune.cpp`
// `main()` into a callable function with:
//   - JSONL training-pair input (one {"prompt":..., "completion":...} per line)
//   - ProgressCallback invoked per step + per epoch
//   - Cooperative cancellation via a std::atomic<bool> checked between
//     optimizer steps
//   - LoRA adapter saved to outLoraPath via llama_adapter_lora_save
//
// As of v0.6.0 this entrypoint returns JNI_FALSE with a clear "not yet
// implemented" message routed through ProgressCallback.onError. The
// surrounding plumbing (Kotlin LlamaFinetune class, JNI wiring, the
// PersonalFineTuneWorker that calls it) is fully built out — when the
// optimizer port lands, this single TU is the only file that needs to
// change.
//
// See TODO(v0.6 P3.2) for the cut-line.

#include <jni.h>
#include <android/log.h>
#include <atomic>
#include <string>

#define TAG "LlamaFinetune"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

// Cooperative cancel — flipped by Java_xyz_ghola_app_ai_llama_LlamaFinetune_cancel,
// checked by the (future) training loop between optimizer steps.
static std::atomic<bool> finetune_cancelled{false};

namespace {

void post_error(JNIEnv *env, jobject progressCb, const char *msg) {
    if (!progressCb) return;
    jclass cls = env->GetObjectClass(progressCb);
    jmethodID onError = env->GetMethodID(cls, "onError", "(Ljava/lang/String;)V");
    if (onError) {
        jstring jmsg = env->NewStringUTF(msg);
        env->CallVoidMethod(progressCb, onError, jmsg);
        env->DeleteLocalRef(jmsg);
    }
    env->DeleteLocalRef(cls);
}

} // namespace

extern "C" {

JNIEXPORT jboolean JNICALL
Java_xyz_ghola_app_ai_llama_LlamaFinetune_run(
    JNIEnv *env, jobject /* this */,
    jstring modelPath, jstring jsonlPath, jstring outLoraPath,
    jobject progressCb, jobject hyperparams) {

    finetune_cancelled.store(false);

    // Surface the inputs for the implementer wiring up the next phase.
    const char *mp = env->GetStringUTFChars(modelPath, nullptr);
    const char *jp = env->GetStringUTFChars(jsonlPath, nullptr);
    const char *op = env->GetStringUTFChars(outLoraPath, nullptr);
    LOGI("finetune request: model=%s jsonl=%s out=%s", mp, jp, op);
    env->ReleaseStringUTFChars(modelPath, mp);
    env->ReleaseStringUTFChars(jsonlPath, jp);
    env->ReleaseStringUTFChars(outLoraPath, op);

    // TODO(v0.6 P3.2): port llama.cpp's examples/training/finetune.cpp main()
    // into a callable function that:
    //   1. llama_model_load_from_file(modelPath) — same as llama_jni.cpp.
    //   2. Parse JSONL with the prompt/completion fields; tokenize each
    //      via llama_tokenize against llama_model_get_vocab.
    //   3. Build a ggml_opt_params with the [Hyperparams] knobs:
    //        - LoRA rank/alpha → forwarded to common/train.cpp's LoRA
    //          attachment helpers.
    //        - learningRate, epochs, batchSize → optimizer config.
    //        - targetModules → which attention/MLP projections to attach.
    //   4. Training loop: for each epoch × step:
    //        - check finetune_cancelled — if true, return JNI_FALSE.
    //        - forward + backward + optimizer step.
    //        - on step: ProgressCallback.onStep(step, total, loss).
    //   5. On epoch boundary: ProgressCallback.onEpoch(...).
    //   6. On completion: llama_adapter_lora_save(adapter, outLoraPath);
    //      ProgressCallback.onComplete(outLoraPath); return JNI_TRUE.
    //   7. Cleanup: llama_free, llama_model_free.
    //
    // The cancel check should run cheaply (< 100ns) between every step.
    // PersonalFineTuneWorker holds a wakelock + foreground notification
    // throughout, so even an unfinished run leaves the device in a sane
    // state.
    post_error(env, progressCb,
        "voice training engine pending — LoRA optimizer port lands next.");
    return JNI_FALSE;
}

JNIEXPORT void JNICALL
Java_xyz_ghola_app_ai_llama_LlamaFinetune_cancel(
    JNIEnv * /* env */, jobject /* this */) {
    finetune_cancelled.store(true);
    LOGI("cancel requested");
}

} // extern "C"
