#include <jni.h>
#include <android/log.h>
#include <string>
#include <atomic>
#include <cmath>
#include <vector>
#include "llama.h"

#define TAG "LlamaCpp"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN, TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

// Process-wide model state. llama.cpp's API doesn't enforce this — we do,
// because (a) loading two models on a 1.5GB-RAM device OOMs and (b) the
// JNI globals below already assume a singleton model pointer. Concurrent
// calls into the JNI from Kotlin would corrupt state regardless; the
// Kotlin facade [LocalLlm] serializes them.
static llama_model *model = nullptr;
static llama_context *ctx = nullptr;
static llama_sampler *sampler = nullptr;
static std::atomic<bool> cancelled{false};

// Active LoRA adapter, if any. Owned here so we can free it on swap / clear /
// release without leaking. The llama.cpp adapter API copies the bytes at init
// time, so the file on disk is decoupled from this handle.
static llama_adapter_lora *lora_adapter = nullptr;

static void cleanup_lora() {
    if (lora_adapter) {
        // Detach from the live context first (no-op if ctx is null).
        if (ctx) llama_clear_adapter_lora(ctx);
        llama_adapter_lora_free(lora_adapter);
        lora_adapter = nullptr;
    }
}

static void cleanup_context() {
    cleanup_lora();
    if (sampler) {
        llama_sampler_free(sampler);
        sampler = nullptr;
    }
    if (ctx) {
        llama_free(ctx);
        ctx = nullptr;
    }
}

extern "C" {

JNIEXPORT jboolean JNICALL
Java_xyz_ghola_app_ai_llama_LlamaCpp_loadModel(
    JNIEnv *env, jobject /* this */,
    jstring modelPath, jint contextSize, jint numThreads,
    jfloat temp, jfloat topP) {

    cleanup_context();
    if (model) {
        llama_model_free(model);
        model = nullptr;
    }

    const char *path = env->GetStringUTFChars(modelPath, nullptr);
    LOGI("Loading model: %s", path);

    llama_model_params model_params = llama_model_default_params();
    model = llama_model_load_from_file(path, model_params);
    env->ReleaseStringUTFChars(modelPath, path);

    if (!model) {
        LOGE("Failed to load model");
        return JNI_FALSE;
    }

    llama_context_params ctx_params = llama_context_default_params();
    ctx_params.n_ctx = contextSize;
    ctx_params.n_threads = numThreads;
    ctx_params.n_threads_batch = numThreads;

    ctx = llama_init_from_model(model, ctx_params);
    if (!ctx) {
        LOGE("Failed to create context");
        llama_model_free(model);
        model = nullptr;
        return JNI_FALSE;
    }

    // Set up sampler chain: top-p -> temperature -> dist
    sampler = llama_sampler_chain_init(llama_sampler_chain_default_params());
    llama_sampler_chain_add(sampler, llama_sampler_init_top_p(topP, 1));
    llama_sampler_chain_add(sampler, llama_sampler_init_temp(temp));
    llama_sampler_chain_add(sampler, llama_sampler_init_dist(LLAMA_DEFAULT_SEED));

    LOGI("Model loaded successfully, ctx_size=%d, threads=%d", contextSize, numThreads);
    return JNI_TRUE;
}

JNIEXPORT jstring JNICALL
Java_xyz_ghola_app_ai_llama_LlamaCpp_generate(
    JNIEnv *env, jobject /* this */,
    jstring prompt, jint maxTokens) {

    if (!model || !ctx || !sampler) {
        return env->NewStringUTF("");
    }

    cancelled.store(false);

    const char *prompt_cstr = env->GetStringUTFChars(prompt, nullptr);
    std::string prompt_str(prompt_cstr);
    env->ReleaseStringUTFChars(prompt, prompt_cstr);

    // Tokenize
    const llama_vocab *vocab = llama_model_get_vocab(model);
    int n_prompt_tokens = -llama_tokenize(vocab, prompt_str.c_str(), prompt_str.size(), nullptr, 0, true, true);
    std::vector<llama_token> tokens(n_prompt_tokens);
    llama_tokenize(vocab, prompt_str.c_str(), prompt_str.size(), tokens.data(), tokens.size(), true, true);

    if (tokens.empty()) {
        LOGE("Tokenization produced no tokens");
        return env->NewStringUTF("");
    }

    // Clear KV cache for fresh generation
    llama_kv_cache_clear(ctx);

    // Process prompt in batch
    llama_batch batch = llama_batch_get_one(tokens.data(), tokens.size());
    if (llama_decode(ctx, batch) != 0) {
        LOGE("Failed to decode prompt");
        return env->NewStringUTF("");
    }

    // Generate tokens
    std::string result;
    const llama_token eos = llama_vocab_eos(vocab);
    const llama_token eot = llama_vocab_eot(vocab);

    for (int i = 0; i < maxTokens; i++) {
        if (cancelled.load()) {
            LOGI("Generation cancelled at token %d", i);
            break;
        }

        llama_token new_token = llama_sampler_sample(sampler, ctx, -1);
        llama_sampler_accept(sampler, new_token);

        if (llama_vocab_is_eog(vocab, new_token)) {
            break;
        }

        char buf[256];
        int n = llama_token_to_piece(vocab, new_token, buf, sizeof(buf), 0, true);
        if (n > 0) {
            result.append(buf, n);
        }

        // Decode the new token for next iteration
        llama_batch single = llama_batch_get_one(&new_token, 1);
        if (llama_decode(ctx, single) != 0) {
            LOGE("Failed to decode token %d", i);
            break;
        }
    }

    return env->NewStringUTF(result.c_str());
}

JNIEXPORT void JNICALL
Java_xyz_ghola_app_ai_llama_LlamaCpp_generateStreaming(
    JNIEnv *env, jobject /* this */,
    jstring prompt, jint maxTokens, jobject callback) {

    if (!model || !ctx || !sampler) {
        return;
    }

    cancelled.store(false);

    jclass callbackClass = env->GetObjectClass(callback);
    jmethodID onToken = env->GetMethodID(callbackClass, "onToken", "(Ljava/lang/String;)V");
    jmethodID onComplete = env->GetMethodID(callbackClass, "onComplete", "()V");

    const char *prompt_cstr = env->GetStringUTFChars(prompt, nullptr);
    std::string prompt_str(prompt_cstr);
    env->ReleaseStringUTFChars(prompt, prompt_cstr);

    // Tokenize
    const llama_vocab *vocab = llama_model_get_vocab(model);
    int n_prompt_tokens = -llama_tokenize(vocab, prompt_str.c_str(), prompt_str.size(), nullptr, 0, true, true);
    std::vector<llama_token> tokens(n_prompt_tokens);
    llama_tokenize(vocab, prompt_str.c_str(), prompt_str.size(), tokens.data(), tokens.size(), true, true);

    if (tokens.empty()) {
        env->CallVoidMethod(callback, onComplete);
        return;
    }

    llama_kv_cache_clear(ctx);

    llama_batch batch = llama_batch_get_one(tokens.data(), tokens.size());
    if (llama_decode(ctx, batch) != 0) {
        env->CallVoidMethod(callback, onComplete);
        return;
    }

    for (int i = 0; i < maxTokens; i++) {
        if (cancelled.load()) break;

        llama_token new_token = llama_sampler_sample(sampler, ctx, -1);
        llama_sampler_accept(sampler, new_token);

        if (llama_vocab_is_eog(vocab, new_token)) break;

        char buf[256];
        int n = llama_token_to_piece(vocab, new_token, buf, sizeof(buf), 0, true);
        if (n > 0) {
            std::string piece(buf, n);
            jstring jpiece = env->NewStringUTF(piece.c_str());
            env->CallVoidMethod(callback, onToken, jpiece);
            env->DeleteLocalRef(jpiece);
        }

        llama_batch single = llama_batch_get_one(&new_token, 1);
        if (llama_decode(ctx, single) != 0) break;
    }

    env->CallVoidMethod(callback, onComplete);
}

JNIEXPORT void JNICALL
Java_xyz_ghola_app_ai_llama_LlamaCpp_cancel(
    JNIEnv * /* env */, jobject /* this */) {
    cancelled.store(true);
}

JNIEXPORT void JNICALL
Java_xyz_ghola_app_ai_llama_LlamaCpp_release(
    JNIEnv * /* env */, jobject /* this */) {
    cancelled.store(true);
    cleanup_context();
    if (model) {
        llama_model_free(model);
        model = nullptr;
    }
    LOGI("Model released");
}

JNIEXPORT jint JNICALL
Java_xyz_ghola_app_ai_llama_LlamaCpp_tokenCount(
    JNIEnv *env, jobject /* this */,
    jstring text) {

    if (!model) return 0;

    const char *text_cstr = env->GetStringUTFChars(text, nullptr);
    std::string text_str(text_cstr);
    env->ReleaseStringUTFChars(text, text_cstr);

    const llama_vocab *vocab = llama_model_get_vocab(model);
    int n = -llama_tokenize(vocab, text_str.c_str(), text_str.size(), nullptr, 0, true, true);
    return n;
}

// ── v0.6 additions ────────────────────────────────────────────────────────────
//
// Three new responsibilities for the JNI:
//
//   1. loadModelWithLora — same as loadModel but accepts an optional LoRA
//      adapter path that's bound at session-creation time. Used as the
//      default inference path post-finetune; the alternative (load base,
//      then applyLora) is reserved for the A/B compare panel that flips
//      adapters on one open context.
//
//   2. applyLora / clearLora — runtime hot-swap. The A/B activity calls
//      clearLora to render the "base" column, then applyLora(path, 1.0)
//      for the "lora" column, on the SAME llama_context. Avoiding two
//      contexts is the difference between 1.5GB resident and 3GB OOM on
//      a Seeker.
//
//   3. embed — pooled-last-token hidden-state vector, used by VoiceMetric
//      to score generations against the user's centroid. Returns
//      n_embd floats (1536 for Qwen 2.5 1.5B), L2-normalized so the
//      Kotlin side can cosine-sim by dot product.

/**
 * Loads a GGUF model and, optionally, an LoRA adapter. Pass null for
 * loraPath to mirror the no-LoRA behavior of loadModel. On failure, the
 * adapter is freed; the base model loads either way.
 */
JNIEXPORT jboolean JNICALL
Java_xyz_ghola_app_ai_llama_LlamaCpp_loadModelWithLora(
    JNIEnv *env, jobject /* this */,
    jstring modelPath, jstring loraPath /* nullable */,
    jint contextSize, jint numThreads,
    jfloat temp, jfloat topP) {

    cleanup_context();
    if (model) {
        llama_model_free(model);
        model = nullptr;
    }

    const char *path = env->GetStringUTFChars(modelPath, nullptr);
    LOGI("Loading model w/ LoRA: %s", path);

    llama_model_params model_params = llama_model_default_params();
    model = llama_model_load_from_file(path, model_params);
    env->ReleaseStringUTFChars(modelPath, path);

    if (!model) {
        LOGE("Failed to load model");
        return JNI_FALSE;
    }

    llama_context_params ctx_params = llama_context_default_params();
    ctx_params.n_ctx = contextSize;
    ctx_params.n_threads = numThreads;
    ctx_params.n_threads_batch = numThreads;

    ctx = llama_init_from_model(model, ctx_params);
    if (!ctx) {
        LOGE("Failed to create context");
        llama_model_free(model);
        model = nullptr;
        return JNI_FALSE;
    }

    // Bind the adapter if the caller passed one. The path is optional so
    // a single Kotlin callsite can express both "load base" and "load with
    // LoRA" without two JNI methods on the hot path.
    if (loraPath) {
        const char *lpath = env->GetStringUTFChars(loraPath, nullptr);
        LOGI("Loading LoRA: %s", lpath);
        lora_adapter = llama_adapter_lora_init(model, lpath);
        env->ReleaseStringUTFChars(loraPath, lpath);
        if (!lora_adapter) {
            LOGW("LoRA init failed — continuing with base model");
        } else if (llama_set_adapter_lora(ctx, lora_adapter, 1.0f) != 0) {
            LOGW("LoRA set failed — continuing with base model");
            llama_adapter_lora_free(lora_adapter);
            lora_adapter = nullptr;
        } else {
            LOGI("LoRA bound at scale 1.0");
        }
    }

    sampler = llama_sampler_chain_init(llama_sampler_chain_default_params());
    llama_sampler_chain_add(sampler, llama_sampler_init_top_p(topP, 1));
    llama_sampler_chain_add(sampler, llama_sampler_init_temp(temp));
    llama_sampler_chain_add(sampler, llama_sampler_init_dist(LLAMA_DEFAULT_SEED));

    LOGI("Model loaded: ctx=%d threads=%d lora=%s",
         contextSize, numThreads, lora_adapter ? "yes" : "no");
    return JNI_TRUE;
}

/**
 * Apply (or replace) the active LoRA adapter on the current context.
 * Caller is responsible for guaranteeing the model is loaded.
 */
JNIEXPORT jboolean JNICALL
Java_xyz_ghola_app_ai_llama_LlamaCpp_applyLora(
    JNIEnv *env, jobject /* this */,
    jstring loraPath, jfloat scale) {

    if (!model || !ctx) {
        LOGE("applyLora: no model/context");
        return JNI_FALSE;
    }
    cleanup_lora();

    const char *lpath = env->GetStringUTFChars(loraPath, nullptr);
    lora_adapter = llama_adapter_lora_init(model, lpath);
    env->ReleaseStringUTFChars(loraPath, lpath);
    if (!lora_adapter) {
        LOGE("applyLora: init failed");
        return JNI_FALSE;
    }
    if (llama_set_adapter_lora(ctx, lora_adapter, scale) != 0) {
        LOGE("applyLora: set failed");
        llama_adapter_lora_free(lora_adapter);
        lora_adapter = nullptr;
        return JNI_FALSE;
    }
    // KV cache contains state from the pre-swap forward passes. Drop it so
    // the next generate() starts fresh with the new adapter — otherwise the
    // A/B compare would mix old/new model state.
    llama_kv_cache_clear(ctx);
    LOGI("applyLora: scale=%.2f", scale);
    return JNI_TRUE;
}

/**
 * Remove the active LoRA — reverts to base model behavior. Used by the
 * A/B compare panel to render the "base" column on the same context.
 */
JNIEXPORT jboolean JNICALL
Java_xyz_ghola_app_ai_llama_LlamaCpp_clearLora(
    JNIEnv * /* env */, jobject /* this */) {

    if (!ctx) return JNI_FALSE;
    cleanup_lora();
    llama_kv_cache_clear(ctx);
    LOGI("clearLora: reverted to base");
    return JNI_TRUE;
}

/**
 * Compute a pooled embedding for [text]. Returns a float[n_embd] vector,
 * L2-normalized so cosine-sim degenerates to a dot product on the Kotlin
 * side.
 *
 * Strategy: tokenize, decode through the full prompt, read the hidden
 * state of the last non-padding position via llama_get_embeddings_ith,
 * normalize. We expose this to support VoiceMetric.score; the v0.5
 * MiniLM-based EmbedderClient remains the corpus-index embedding space
 * (different space, different purpose).
 */
JNIEXPORT jfloatArray JNICALL
Java_xyz_ghola_app_ai_llama_LlamaCpp_embed(
    JNIEnv *env, jobject /* this */,
    jstring text) {

    if (!model || !ctx) {
        return env->NewFloatArray(0);
    }

    const char *text_cstr = env->GetStringUTFChars(text, nullptr);
    std::string text_str(text_cstr);
    env->ReleaseStringUTFChars(text, text_cstr);

    const llama_vocab *vocab = llama_model_get_vocab(model);
    int n_prompt = -llama_tokenize(vocab, text_str.c_str(), text_str.size(),
                                   nullptr, 0, true, true);
    if (n_prompt <= 0) {
        return env->NewFloatArray(0);
    }
    std::vector<llama_token> tokens(n_prompt);
    llama_tokenize(vocab, text_str.c_str(), text_str.size(),
                   tokens.data(), tokens.size(), true, true);

    llama_kv_cache_clear(ctx);
    llama_batch batch = llama_batch_get_one(tokens.data(), tokens.size());
    if (llama_decode(ctx, batch) != 0) {
        LOGE("embed: decode failed");
        return env->NewFloatArray(0);
    }

    int n_embd = llama_model_n_embd(model);
    // llama_get_embeddings_ith returns the hidden state of position i.
    // Position (n - 1) is the final token of the prompt, which (for
    // causal LMs) summarizes the whole sequence — same convention every
    // production text-embedding model uses with a non-bidirectional base.
    const float *raw = llama_get_embeddings_ith(ctx, (int) tokens.size() - 1);
    if (!raw) {
        LOGE("embed: get_embeddings_ith returned null");
        return env->NewFloatArray(0);
    }

    // L2-normalize so cosine-sim ≡ dot product.
    double norm = 0.0;
    for (int i = 0; i < n_embd; i++) norm += (double) raw[i] * raw[i];
    norm = std::sqrt(norm);
    if (norm < 1e-9) norm = 1e-9; // guard against zero vector

    jfloatArray out = env->NewFloatArray(n_embd);
    std::vector<float> normalized(n_embd);
    for (int i = 0; i < n_embd; i++) normalized[i] = (float) (raw[i] / norm);
    env->SetFloatArrayRegion(out, 0, n_embd, normalized.data());
    return out;
}

} // extern "C"
