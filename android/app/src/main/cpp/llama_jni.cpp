#include <jni.h>
#include <android/log.h>
#include <string>
#include <atomic>
#include "llama.h"

#define TAG "LlamaCpp"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

static llama_model *model = nullptr;
static llama_context *ctx = nullptr;
static llama_sampler *sampler = nullptr;
static std::atomic<bool> cancelled{false};

static void cleanup_context() {
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
Java_xyz_orni_thumper_ai_llama_LlamaCpp_loadModel(
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
Java_xyz_orni_thumper_ai_llama_LlamaCpp_generate(
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
    llama_kv_self_clear(ctx);

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
Java_xyz_orni_thumper_ai_llama_LlamaCpp_generateStreaming(
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

    llama_kv_self_clear(ctx);

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
Java_xyz_orni_thumper_ai_llama_LlamaCpp_cancel(
    JNIEnv * /* env */, jobject /* this */) {
    cancelled.store(true);
}

JNIEXPORT void JNICALL
Java_xyz_orni_thumper_ai_llama_LlamaCpp_release(
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
Java_xyz_orni_thumper_ai_llama_LlamaCpp_tokenCount(
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

} // extern "C"
