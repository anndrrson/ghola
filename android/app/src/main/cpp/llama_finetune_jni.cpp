// v0.6 Phase F — JNI bridge for the personal LoRA fine-tune.
//
// Replaces the v0.6.0 no-op stub. Calls into finetune_loop.cpp's
// run_finetune with marshaled hyperparams, tokenized training pairs,
// and a callback adapter that bridges ProgressCallback (Kotlin) onto
// FinetuneCallbacks (C++).
//
// Threading model: this entire function runs on the JNI caller's
// thread (PersonalFineTuneWorker's WorkManager-managed background
// thread). All progress callbacks fire from that same thread, so the
// JNIEnv pointer captured at entry is valid throughout. ggml's internal
// compute thread pool does NOT call our callbacks — it just parallelizes
// the matmul kernels, and joins back to the calling thread before any
// callback fires.
//
// Cancellation contract: PersonalFineTuneWorker calls
// LlamaFinetune.cancel() which flips finetune_cancelled to true. The
// inner loop polls this between every optimizer step (cheap atomic
// load). On cancel: cleanup, return JNI_FALSE, no partial adapter.

#include "adapter_writer.h"
#include "finetune_loop.h"
#include "lora_modules.h"
#include "qwen_forward.h"

#include "ggml.h"
#include "llama.h"

#include <jni.h>
#include <android/log.h>
#include <atomic>
#include <chrono>
#include <cstring>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#define TAG "LlamaFinetune"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN,  TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

// Cooperative cancel — flipped by Java_xyz_ghola_app_ai_llama_LlamaFinetune_cancel.
static std::atomic<bool> finetune_cancelled{false};

namespace {

// ─── JNI helpers ─────────────────────────────────────────────────────────

std::string jstring_to_string(JNIEnv * env, jstring s) {
    if (!s) return {};
    const char * c = env->GetStringUTFChars(s, nullptr);
    std::string out(c);
    env->ReleaseStringUTFChars(s, c);
    return out;
}

void post_error(JNIEnv * env, jobject cb, const char * msg) {
    if (!cb) return;
    jclass cls = env->GetObjectClass(cb);
    jmethodID m = env->GetMethodID(cls, "onError", "(Ljava/lang/String;)V");
    if (m) {
        jstring js = env->NewStringUTF(msg);
        env->CallVoidMethod(cb, m, js);
        env->DeleteLocalRef(js);
    }
    env->DeleteLocalRef(cls);
}

void post_complete(JNIEnv * env, jobject cb, const char * path) {
    if (!cb) return;
    jclass cls = env->GetObjectClass(cb);
    jmethodID m = env->GetMethodID(cls, "onComplete", "(Ljava/lang/String;)V");
    if (m) {
        jstring js = env->NewStringUTF(path);
        env->CallVoidMethod(cb, m, js);
        env->DeleteLocalRef(js);
    }
    env->DeleteLocalRef(cls);
}

// ─── Hyperparam unmarshaling ─────────────────────────────────────────────

ghola::FinetuneHyperparams parse_hyperparams(JNIEnv * env, jobject hyper) {
    ghola::FinetuneHyperparams out;
    if (!hyper) return out;

    // Use Kotlin's public getter methods rather than backing fields. The
    // private field names are an implementation detail the Kotlin compiler
    // is free to change; the getter contract is part of the public ABI
    // (data class invariant + JvmStatic considerations).
    jclass cls = env->GetObjectClass(hyper);
    auto call_int = [&](const char * getter) -> int {
        jmethodID m = env->GetMethodID(cls, getter, "()I");
        return m ? env->CallIntMethod(hyper, m) : 0;
    };
    auto call_float = [&](const char * getter) -> float {
        jmethodID m = env->GetMethodID(cls, getter, "()F");
        return m ? env->CallFloatMethod(hyper, m) : 0.0f;
    };

    out.rank          = call_int  ("getRank");
    out.alpha         = call_float("getAlpha");
    out.learning_rate = call_float("getLearningRate");
    out.epochs        = call_int  ("getEpochs");
    out.batch_size    = call_int  ("getBatchSize");
    out.ctx_len       = call_int  ("getCtxLen");

    // Sanity-clamp out-of-range values so a misconfigured caller can't
    // produce an immediately-divergent training run.
    if (out.rank < 1 || out.rank > 256) {
        LOGW("parse_hyperparams: clamping rank %d → 16", out.rank);
        out.rank = 16;
    }
    if (out.alpha <= 0.0f || out.alpha > 1024.0f) {
        LOGW("parse_hyperparams: clamping alpha %.2f → 32.0", out.alpha);
        out.alpha = 32.0f;
    }
    if (out.learning_rate <= 0.0f || out.learning_rate > 1.0f) {
        LOGW("parse_hyperparams: clamping learning_rate %.4e → 3e-4", out.learning_rate);
        out.learning_rate = 3e-4f;
    }
    if (out.epochs < 1 || out.epochs > 64) {
        LOGW("parse_hyperparams: clamping epochs %d → 3", out.epochs);
        out.epochs = 3;
    }
    if (out.ctx_len < 64 || out.ctx_len > 8192) {
        LOGW("parse_hyperparams: clamping ctx_len %d → 1024", out.ctx_len);
        out.ctx_len = 1024;
    }
    if (out.batch_size < 1) out.batch_size = 1;

    env->DeleteLocalRef(cls);
    return out;
}

// ─── JSONL parsing ───────────────────────────────────────────────────────
//
// We only need two fields: prompt + completion. Both are JSON-escaped
// strings. Rather than pull in a JSON dep, we do a minimal field
// extractor that handles the common escapes (\", \\, \n, \r, \t) and
// requires the JSONL writer to keep each pair on a single line — which
// TrainingPairGenerator already does.

bool unescape_json_string(const std::string & in, std::string & out) {
    out.clear();
    out.reserve(in.size());
    for (size_t i = 0; i < in.size(); ++i) {
        char c = in[i];
        if (c == '\\' && i + 1 < in.size()) {
            char n = in[i + 1];
            switch (n) {
                case '"':  out += '"';  i++; break;
                case '\\': out += '\\'; i++; break;
                case '/':  out += '/';  i++; break;
                case 'n':  out += '\n'; i++; break;
                case 'r':  out += '\r'; i++; break;
                case 't':  out += '\t'; i++; break;
                default:   out += c; break;
            }
        } else {
            out += c;
        }
    }
    return true;
}

bool extract_string_field(const std::string & line, const std::string & key, std::string & out) {
    // Match `"key"` followed by optional whitespace + `:` + optional ws + `"...value..."`.
    const std::string needle = "\"" + key + "\"";
    size_t p = line.find(needle);
    if (p == std::string::npos) return false;
    p += needle.size();
    // Skip whitespace + colon + whitespace.
    while (p < line.size() && (line[p] == ' ' || line[p] == '\t')) ++p;
    if (p >= line.size() || line[p] != ':') return false;
    ++p;
    while (p < line.size() && (line[p] == ' ' || line[p] == '\t')) ++p;
    if (p >= line.size() || line[p] != '"') return false;
    ++p;
    // Find closing quote, handling escape sequences.
    std::string raw;
    while (p < line.size()) {
        char c = line[p];
        if (c == '\\' && p + 1 < line.size()) {
            raw += c;
            raw += line[p + 1];
            p += 2;
            continue;
        }
        if (c == '"') {
            return unescape_json_string(raw, out);
        }
        raw += c;
        ++p;
    }
    return false;
}

// ─── Pair tokenization (loads llama_model ONCE for vocab access) ──────────

bool load_and_tokenize_pairs(
    const std::string & model_path,
    const std::string & jsonl_path,
    int ctx_len_limit,
    std::vector<ghola::TokenizedPair> & out)
{
    llama_model_params mp = llama_model_default_params();
    mp.use_mmap  = true;
    mp.use_mlock = false;
    llama_model * lmodel = llama_model_load_from_file(model_path.c_str(), mp);
    if (!lmodel) {
        LOGE("load_and_tokenize_pairs: llama_model_load_from_file failed");
        return false;
    }
    const llama_vocab * vocab = llama_model_get_vocab(lmodel);

    auto tokenize_str = [&](const std::string & s, bool add_bos, std::vector<int32_t> & dst) -> bool {
        const int max_toks = (int) s.size() + 16;
        std::vector<llama_token> buf(max_toks);
        const int n = llama_tokenize(
            vocab, s.data(), (int) s.size(),
            buf.data(), max_toks, add_bos, /*parse_special=*/ true);
        if (n < 0) {
            // Negative return = need (-n) tokens. One retry with the right size.
            buf.resize(-n);
            const int n2 = llama_tokenize(
                vocab, s.data(), (int) s.size(),
                buf.data(), (int) buf.size(), add_bos, true);
            if (n2 < 0) return false;
            dst.assign(buf.begin(), buf.begin() + n2);
            return true;
        }
        dst.assign(buf.begin(), buf.begin() + n);
        return true;
    };

    std::ifstream f(jsonl_path);
    if (!f.is_open()) {
        LOGE("load_and_tokenize_pairs: cannot open '%s'", jsonl_path.c_str());
        llama_model_free(lmodel);
        return false;
    }

    int n_loaded = 0;
    int n_skipped_oversize = 0;
    int n_skipped_parse = 0;
    std::string line;
    while (std::getline(f, line)) {
        if (line.empty()) continue;
        std::string prompt, completion;
        if (!extract_string_field(line, "prompt",     prompt) ||
            !extract_string_field(line, "completion", completion)) {
            ++n_skipped_parse;
            continue;
        }
        ghola::TokenizedPair pair;
        if (!tokenize_str(prompt,     /*add_bos=*/ true,  pair.prompt_tokens) ||
            !tokenize_str(completion, /*add_bos=*/ false, pair.completion_tokens)) {
            ++n_skipped_parse;
            continue;
        }
        if ((int)(pair.prompt_tokens.size() + pair.completion_tokens.size()) > ctx_len_limit) {
            ++n_skipped_oversize;
            continue;
        }
        out.push_back(std::move(pair));
        ++n_loaded;
    }

    LOGI("load_and_tokenize_pairs: %d loaded, %d oversize, %d unparseable",
         n_loaded, n_skipped_oversize, n_skipped_parse);

    llama_model_free(lmodel);
    return n_loaded > 0;
}

} // anonymous

extern "C" {

JNIEXPORT jboolean JNICALL
Java_xyz_ghola_app_ai_llama_LlamaFinetune_run(
    JNIEnv * env, jobject /* this */,
    jstring modelPath, jstring jsonlPath, jstring outLoraPath,
    jobject progressCb, jobject hyperparams)
{
    finetune_cancelled.store(false);

    const std::string model_path = jstring_to_string(env, modelPath);
    const std::string jsonl_path = jstring_to_string(env, jsonlPath);
    const std::string out_path   = jstring_to_string(env, outLoraPath);

    LOGI("finetune request: model=%s jsonl=%s out=%s",
         model_path.c_str(), jsonl_path.c_str(), out_path.c_str());

    ghola::FinetuneHyperparams hp = parse_hyperparams(env, hyperparams);
    LOGI("hyperparams: rank=%d alpha=%.1f lr=%.2e epochs=%d ctx_len=%d",
         hp.rank, hp.alpha, hp.learning_rate, hp.epochs, hp.ctx_len);

    // ── 1. Tokenize training data ──────────────────────────────────────
    std::vector<ghola::TokenizedPair> pairs;
    if (!load_and_tokenize_pairs(model_path, jsonl_path, hp.ctx_len, pairs)) {
        post_error(env, progressCb, "no usable training pairs in JSONL");
        return JNI_FALSE;
    }
    if (finetune_cancelled.load()) {
        post_error(env, progressCb, "cancelled");
        return JNI_FALSE;
    }

    // ── 2. Load Qwen base model via our forward path ───────────────────
    ghola::QwenModel model;
    if (!ghola::qwen_model_load(model, model_path)) {
        post_error(env, progressCb, "qwen_model_load failed");
        return JNI_FALSE;
    }

    // ── 3. Build + initialize LoRA ─────────────────────────────────────
    // The LoraSet's tensors live in a static context that persists across
    // the whole run; we hand the same ctx to lora_set_build for both
    // tensor allocation AND ggml_set_param marking. AdamW state lives
    // here too (m_A, v_A, m_B, v_B per module).
    //
    // Memory accounting: 112 modules × 2 tensors (A+B) × ~3 × (in_dim+out_dim)×r×4B
    // ≈ 112 × 4 × (1536+1536)×16×4 ≈ 88 MB. Comfortable.
    struct ggml_init_params lp = {
        /*.mem_size   =*/ 256 * 1024 * 1024,
        /*.mem_buffer =*/ nullptr,
        /*.no_alloc   =*/ false,
    };
    ggml_context * lora_ctx = ggml_init(lp);
    if (!lora_ctx) {
        ghola::qwen_model_free(model);
        post_error(env, progressCb, "lora_ctx allocation failed");
        return JNI_FALSE;
    }

    ghola::LoraSet lora;
    const std::vector<std::string> target_names = {
        "attn_q.weight", "attn_k.weight", "attn_v.weight", "attn_output.weight",
    };
    if (!ghola::lora_set_build(
            lora, lora_ctx,
            ghola::QwenConfig::n_layer,
            ghola::QwenConfig::hidden_dim,
            ghola::QwenConfig::kv_dim,
            target_names,
            hp.rank, hp.alpha)) {
        ghola::qwen_model_free(model);
        ggml_free(lora_ctx);
        post_error(env, progressCb, "lora_set_build failed");
        return JNI_FALSE;
    }
    ghola::lora_set_init_weights(lora, /*seed=*/ 0x5EED);

    // ── 4. Adapter for ProgressCallback → FinetuneCallbacks ────────────
    // jobject + jclass cached once; env captured. Safe because the entire
    // training run executes on this same JNI thread.
    jclass cb_cls = progressCb ? env->GetObjectClass(progressCb) : nullptr;
    jmethodID on_step_mid  = cb_cls ? env->GetMethodID(cb_cls, "onStep",  "(IIF)V") : nullptr;
    jmethodID on_epoch_mid = cb_cls ? env->GetMethodID(cb_cls, "onEpoch", "(IIF)V") : nullptr;

    ghola::FinetuneCallbacks cb;
    cb.on_step  = [&](int step, int total, float loss) {
        if (progressCb && on_step_mid) {
            env->CallVoidMethod(progressCb, on_step_mid, (jint) step, (jint) total, (jfloat) loss);
        }
    };
    cb.on_epoch = [&](int epoch, int total, float loss) {
        if (progressCb && on_epoch_mid) {
            env->CallVoidMethod(progressCb, on_epoch_mid, (jint) epoch, (jint) total, (jfloat) loss);
        }
    };
    cb.is_cancelled = []() -> bool { return finetune_cancelled.load(); };

    // ── 5. Run the training loop ───────────────────────────────────────
    const auto t_start = std::chrono::steady_clock::now();
    const bool ok = ghola::run_finetune(model, lora, pairs, hp, cb, out_path);
    const auto t_end = std::chrono::steady_clock::now();
    const long run_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                            t_end - t_start).count();

    // ── 6. On success: serialize final adapter ─────────────────────────
    if (ok) {
        ghola::AdapterMeta meta;
        meta.architecture = "qwen2";
        meta.step  = lora.step;
        meta.epoch = hp.epochs;
        meta.run_ms = run_ms;
        if (ghola::write_lora_gguf(lora, meta, out_path)) {
            LOGI("finetune complete: %s (%ld ms)", out_path.c_str(), run_ms);
            post_complete(env, progressCb, out_path.c_str());
        } else {
            post_error(env, progressCb, "adapter serialization failed");
            ghola::qwen_model_free(model);
            ggml_free(lora_ctx);
            if (cb_cls) env->DeleteLocalRef(cb_cls);
            return JNI_FALSE;
        }
    } else {
        // run_finetune returns false on cancel OR fatal error. We report
        // a cancel-specific message when the flag is set, otherwise a
        // generic failure — the inner loop has already LOGE'd specifics.
        if (finetune_cancelled.load()) {
            post_error(env, progressCb, "cancelled");
        } else {
            post_error(env, progressCb, "training failed — see logcat for details");
        }
    }

    ghola::qwen_model_free(model);
    ggml_free(lora_ctx);
    if (cb_cls) env->DeleteLocalRef(cb_cls);

    return ok ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT void JNICALL
Java_xyz_ghola_app_ai_llama_LlamaFinetune_cancel(
    JNIEnv * /* env */, jobject /* this */) {
    finetune_cancelled.store(true);
    LOGI("cancel requested");
}

} // extern "C"
