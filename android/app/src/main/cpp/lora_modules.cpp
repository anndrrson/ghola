// v0.6 Phase B implementation. See lora_modules.h for the contract.
//
// Naming convention details:
//   - "attn_q" maps to "blk.{layer}.attn_q.weight"
//   - "attn_k" → "blk.{layer}.attn_k.weight"
//   - "attn_v" → "blk.{layer}.attn_v.weight"
//   - "attn_output" → "blk.{layer}.attn_output.weight"
//
// llama.cpp uses these short names in its GGUF model files for Qwen 2.5.
// Verify against the loaded base GGUF tensor list before training.

#include "lora_modules.h"

#include <android/log.h>
#include <cmath>
#include <cstring>
#include <random>

#define TAG "LoraModules"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN,  TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

namespace ghola {

static ggml_tensor * alloc_2d(ggml_context * ctx, int d0, int d1, const char * name) {
    ggml_tensor * t = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, d0, d1);
    if (!t) return nullptr;
    ggml_set_name(t, name);
    return t;
}

bool lora_set_build(
    LoraSet & set,
    ggml_context * ctx,
    int num_layers,
    int hidden_dim,
    int kv_dim,
    const std::vector<std::string> & target_names,
    int rank,
    float alpha)
{
    if (!ctx || num_layers <= 0 || rank <= 0 || target_names.empty()) {
        LOGE("lora_set_build: invalid args");
        return false;
    }

    set.ctx = ctx;
    set.rank = rank;
    set.alpha = alpha;
    set.step = 0;
    set.modules.clear();
    set.order.clear();

    for (int layer = 0; layer < num_layers; ++layer) {
        for (const std::string & target : target_names) {
            // Determine output dim from the target name.
            // - attn_q / attn_output project to hidden_dim
            // - attn_k / attn_v project to kv_dim (GQA — fewer KV heads)
            int out_dim;
            if (target == "attn_k" || target == "attn_v") {
                out_dim = kv_dim;
            } else if (target == "attn_q" || target == "attn_output") {
                out_dim = hidden_dim;
            } else {
                // For future MLP targets (gate_proj/up_proj/down_proj) the
                // dims differ — the caller passes them explicitly via a
                // future overload. For v0.6 we attach to attention-only.
                LOGW("lora_set_build: unknown target '%s' — skipping", target.c_str());
                continue;
            }

            const int in_dim = (target == "attn_output") ? hidden_dim : hidden_dim;
            const std::string base_name = "blk." + std::to_string(layer) + "." + target + ".weight";

            LoraModule m;
            m.base_tensor_name = base_name;
            m.in_dim = in_dim;
            m.out_dim = out_dim;
            m.rank = rank;
            m.scale = alpha / float(rank);

            const std::string a_name  = base_name + ".lora_a";
            const std::string b_name  = base_name + ".lora_b";
            const std::string mA_name = base_name + ".lora_a.m";
            const std::string vA_name = base_name + ".lora_a.v";
            const std::string mB_name = base_name + ".lora_b.m";
            const std::string vB_name = base_name + ".lora_b.v";

            m.A   = alloc_2d(ctx, in_dim, rank,   a_name.c_str());
            m.B   = alloc_2d(ctx, rank,   out_dim, b_name.c_str());
            m.m_A = alloc_2d(ctx, in_dim, rank,   mA_name.c_str());
            m.v_A = alloc_2d(ctx, in_dim, rank,   vA_name.c_str());
            m.m_B = alloc_2d(ctx, rank,   out_dim, mB_name.c_str());
            m.v_B = alloc_2d(ctx, rank,   out_dim, vB_name.c_str());

            if (!m.A || !m.B || !m.m_A || !m.v_A || !m.m_B || !m.v_B) {
                LOGE("lora_set_build: tensor alloc failed at %s (out of ctx memory)",
                     base_name.c_str());
                return false;
            }

            // Mark A and B as trainable. m_A/v_A/m_B/v_B are NOT trainable —
            // they hold optimizer state, the optimizer mutates them but
            // backward doesn't compute gradients for them.
            ggml_set_param(ctx, m.A);
            ggml_set_param(ctx, m.B);

            set.modules.emplace(base_name, std::move(m));
            set.order.push_back(base_name);
        }
    }

    LOGI("lora_set_build: %zu modules built (layers=%d, rank=%d, alpha=%.1f)",
         set.modules.size(), num_layers, rank, alpha);
    return true;
}

void lora_set_init_weights(LoraSet & set, uint64_t seed) {
    std::mt19937_64 rng(seed);

    for (const std::string & name : set.order) {
        LoraModule & m = set.modules[name];

        // Kaiming-init A with stddev = sqrt(1/rank). This is the LoRA
        // paper's exact convention. The N(0, 1/r) variance keeps the
        // initial A·x activations roughly the same magnitude as x,
        // independent of rank.
        const float std_a = std::sqrt(1.0f / float(m.rank));
        std::normal_distribution<float> dist_a(0.0f, std_a);
        float * a_data = (float *) m.A->data;
        const size_t a_n = ggml_nelements(m.A);
        for (size_t i = 0; i < a_n; ++i) a_data[i] = dist_a(rng);

        // Zero-init B. Critical: with B=0, the LoRA contribution at step 0
        // is exactly zero, so the model behaves identically to the base
        // model. Training nudges B away from zero gradually.
        float * b_data = (float *) m.B->data;
        std::memset(b_data, 0, ggml_nbytes(m.B));

        // Zero AdamW state (m, v are all zero at step 0).
        std::memset(m.m_A->data, 0, ggml_nbytes(m.m_A));
        std::memset(m.v_A->data, 0, ggml_nbytes(m.v_A));
        std::memset(m.m_B->data, 0, ggml_nbytes(m.m_B));
        std::memset(m.v_B->data, 0, ggml_nbytes(m.v_B));
    }
    set.step = 0;

    LOGI("lora_set_init_weights: %zu modules initialized (seed=%llu)",
         set.modules.size(), (unsigned long long) seed);
}

void lora_set_free(LoraSet & set) {
    if (set.ctx) {
        ggml_free(set.ctx);
        set.ctx = nullptr;
    }
    set.modules.clear();
    set.order.clear();
}

} // namespace ghola
