// v0.6 Phase A — Qwen 2.5 1.5B forward in GGML.
//
// STATUS AS OF THIS COMMIT: Phase A.1 + A.2 drafted, A.3 still stubbed.
//
//   ✅ QwenModel + QwenLayer structs
//   ✅ qwen_model_load — pulls every base tensor out of the GGUF by
//      llama.cpp's naming convention and stores pointers.
//   ✅ qwen_model_free — releases the gguf_context.
//   ✅ qwen_forward_build top-level scaffold.
//   ⚠️  build_attn_block — DRAFTED but UNVERIFIED. Mirrors llm_build_kqv
//      + build_qwen2 at b4524 (RoPE, GQA, causal-masked softmax). Has
//      not been parity-checked against llama_decode yet.
//   ⚠️  build_mlp_block — DRAFTED but UNVERIFIED. SwiGLU MLP per
//      llm_build_ffn(LLM_FFN_SILU, LLM_FFN_PAR).
//   ❌  qwen_parity_check — STUBBED. Returns 0. TODO A.3.
//
// Pre-Phase-B gate is unchanged: parity_check must show 20-token greedy
// match against llama_decode before we declare A done. Until then, we
// CAN compile this file, but training a LoRA against it produces an
// adapter that the inference runtime will reject as garbage.

#include "qwen_forward.h"

#include "ggml.h"
#include "ggml-alloc.h"
#include "ggml-backend.h"
#include "ggml-cpu.h"
#include "gguf.h"
#include "llama.h"

#include <android/log.h>
#include <chrono>
#include <cmath>
#include <cstring>
#include <unordered_map>

#define TAG "QwenForward"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN,  TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

namespace ghola {

namespace {

ggml_tensor * find_tensor(ggml_context * ctx, const std::string & name) {
    ggml_tensor * t = ggml_get_tensor(ctx, name.c_str());
    if (!t) {
        LOGW("qwen_model_load: missing tensor '%s'", name.c_str());
    }
    return t;
}

ggml_tensor * find_tensor_optional(ggml_context * ctx, const std::string & name) {
    // Some tensors (biases, tied lm_head) may legitimately not exist —
    // don't warn on these.
    return ggml_get_tensor(ctx, name.c_str());
}

} // anonymous

bool qwen_model_load(QwenModel & model, const std::string & gguf_path) {
    struct gguf_init_params params = {
        /*.no_alloc =*/ false,
        /*.ctx      =*/ &model.weights_ctx,
    };
    gguf_context * gguf = gguf_init_from_file(gguf_path.c_str(), params);
    if (!gguf) {
        LOGE("qwen_model_load: gguf_init_from_file failed for '%s'", gguf_path.c_str());
        return false;
    }
    model.gguf = gguf;

    // Top-level tensors.
    model.tok_embed    = find_tensor(model.weights_ctx, "token_embd.weight");
    model.output_norm  = find_tensor(model.weights_ctx, "output_norm.weight");
    // lm_head may be tied to the token embedding in Qwen 2.5 — if absent,
    // we'll alias to tok_embed at forward time.
    model.lm_head      = find_tensor_optional(model.weights_ctx, "output.weight");
    if (!model.lm_head) {
        LOGI("qwen_model_load: output.weight not present — assuming tied lm_head");
        model.lm_head = model.tok_embed;
    }
    if (!model.tok_embed || !model.output_norm) {
        LOGE("qwen_model_load: missing top-level tensors");
        return false;
    }

    // Per-layer tensors.
    model.layers.resize(QwenConfig::n_layer);
    for (int i = 0; i < QwenConfig::n_layer; ++i) {
        QwenLayer & L = model.layers[i];
        const std::string p = "blk." + std::to_string(i) + ".";

        L.attn_norm   = find_tensor(model.weights_ctx, p + "attn_norm.weight");
        L.attn_q      = find_tensor(model.weights_ctx, p + "attn_q.weight");
        L.attn_k      = find_tensor(model.weights_ctx, p + "attn_k.weight");
        L.attn_v      = find_tensor(model.weights_ctx, p + "attn_v.weight");
        L.attn_output = find_tensor(model.weights_ctx, p + "attn_output.weight");
        // Qwen 2 attention biases — present in Qwen 2.0, removed in Qwen 2.5
        // Instruct. Optional.
        L.attn_q_bias = find_tensor_optional(model.weights_ctx, p + "attn_q.bias");
        L.attn_k_bias = find_tensor_optional(model.weights_ctx, p + "attn_k.bias");
        L.attn_v_bias = find_tensor_optional(model.weights_ctx, p + "attn_v.bias");
        L.ffn_norm    = find_tensor(model.weights_ctx, p + "ffn_norm.weight");
        L.ffn_gate    = find_tensor(model.weights_ctx, p + "ffn_gate.weight");
        L.ffn_up      = find_tensor(model.weights_ctx, p + "ffn_up.weight");
        L.ffn_down    = find_tensor(model.weights_ctx, p + "ffn_down.weight");

        if (!L.attn_norm || !L.attn_q || !L.attn_k || !L.attn_v ||
            !L.attn_output || !L.ffn_norm || !L.ffn_gate || !L.ffn_up ||
            !L.ffn_down) {
            LOGE("qwen_model_load: missing tensors in layer %d", i);
            return false;
        }
    }

    LOGI("qwen_model_load: %d layers loaded from %s", QwenConfig::n_layer, gguf_path.c_str());
    return true;
}

void qwen_model_free(QwenModel & model) {
    if (model.gguf) {
        gguf_free((gguf_context *) model.gguf);
        model.gguf = nullptr;
    }
    if (model.weights_ctx) {
        ggml_free(model.weights_ctx);
        model.weights_ctx = nullptr;
    }
    model.layers.clear();
    model.tok_embed = nullptr;
    model.output_norm = nullptr;
    model.lm_head = nullptr;
}

// ─────────────────────────────────────────────────────────────────────────
// Layer builders
// ─────────────────────────────────────────────────────────────────────────

/**
 * Inject the LoRA delta into a projection if a matching module exists.
 *
 * For target tensor name `key` (e.g., "blk.7.attn_q.weight"):
 *   y_base = W · x       (already computed by the caller)
 *   if lora has key:  y = y_base + scale · B · (A · x)
 *
 * Both A·x and B·(A·x) participate in the autograd graph because A and B
 * were marked ggml_set_param at lora_set_build time. The base weight W
 * is frozen (not param'd) so its gradient is never computed.
 *
 * Returns y_base unchanged if no LoRA module exists for `key`.
 *
 * SCALE PARITY: m.scale = alpha/rank (baked at lora_set_build). Inference
 * computes the same effective scale via llama_adapter_lora_weight::get_scale:
 *   inference: adapter_scale * alpha / rank, with adapter_scale=1.0 from
 *              our applyLora(path, 1.0f) call → 32/16 = 2.0
 *   training:  m.scale = alpha/rank = 32/16 = 2.0
 * Verified against src/llama.cpp:213-220 + src/llama-adapter.h:get_scale.
 */
static ggml_tensor * apply_lora_delta(
    ggml_context * ctx,
    ggml_tensor * y_base,
    ggml_tensor * x,
    const std::string & key,
    const LoraSet * lora)
{
    if (!lora) return y_base;
    auto it = lora->modules.find(key);
    if (it == lora->modules.end()) return y_base;
    const LoraModule & m = it->second;

    // ggml_mul_mat(A, x) computes A^T · x. Our A has shape [in, r], so
    // A^T·x produces [r, seq] when x is [in, seq]. Then B [r, out] @ that
    // gives [out, seq] — matching y_base's shape.
    ggml_tensor * a_x = ggml_mul_mat(ctx, m.A, x);           // [r, seq]
    ggml_tensor * b_a_x = ggml_mul_mat(ctx, m.B, a_x);       // [out, seq]
    ggml_tensor * scaled = ggml_scale(ctx, b_a_x, m.scale);
    return ggml_add(ctx, y_base, scaled);
}

/**
 * Build the per-token causal attention mask: mask[j, i] = 0 if j ≤ i,
 * else -inf. Shape: [n_tokens, n_tokens]. ggml_soft_max_ext adds this
 * mask to the kq tensor before softmax, with broadcast across heads.
 *
 * Filled with the causal pattern at graph build time. For training, we
 * always process the full prompt+completion in one shot, so this is
 * sufficient — no KV cache, no incremental masking required.
 */
static ggml_tensor * build_causal_mask(ggml_context * ctx, int n_tokens) {
    ggml_tensor * mask = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, n_tokens, n_tokens);
    ggml_set_name(mask, "KQ_mask");
    if (ggml_get_no_alloc(ctx)) {
        // Caller fills via qwen_fill_kq_mask after gallocr_alloc_graph.
        return mask;
    }
    // Fill with causal mask: row i can attend to cols 0..i, else -inf.
    float * d = (float *) mask->data;
    const float neg_inf = -INFINITY;
    for (int q = 0; q < n_tokens; ++q) {
        for (int k = 0; k < n_tokens; ++k) {
            d[q * n_tokens + k] = (k <= q) ? 0.0f : neg_inf;
        }
    }
    return mask;
}

// ─────────────────────────────────────────────────────────────────────────
// Phase E helpers — fill graph inputs after gallocr_alloc_graph.
// ─────────────────────────────────────────────────────────────────────────

void qwen_fill_kq_mask(ggml_tensor * mask, int n_tokens) {
    std::vector<float> data((size_t) n_tokens * n_tokens);
    const float neg_inf = -INFINITY;
    for (int q = 0; q < n_tokens; ++q) {
        for (int k = 0; k < n_tokens; ++k) {
            data[(size_t) q * n_tokens + k] = (k <= q) ? 0.0f : neg_inf;
        }
    }
    ggml_backend_tensor_set(mask, data.data(), 0, data.size() * sizeof(float));
}

void qwen_fill_int32(ggml_tensor * tensor, const int32_t * src, int n) {
    ggml_backend_tensor_set(tensor, src, 0, (size_t) n * sizeof(int32_t));
}

/**
 * Qwen 2 attention forward with LoRA injection.
 *
 * Mirrors llama.cpp's build_qwen2 + llm_build_kqv at tag b4524 (see
 * src/llama.cpp:3341-3385 and src/llama.cpp:540-661 in the vendored
 * tree). Same op sequence, same tensor layouts; we add the LoRA delta
 * at each q/k/v/o projection.
 *
 * ⚠️  VERIFICATION STATUS: this is mathematically translated from the
 * reference but has NOT been run through Phase A.3's parity check yet.
 * The likely silent bugs:
 *   - RoPE parameter mismatch (mode, n_ctx_orig, freq_base)
 *   - GQA broadcast pattern (whether mul_mat handles n_kv_head < n_head
 *     automatically vs needing explicit ggml_repeat — at b4524 it should,
 *     because that's what llm_build_kqv depends on)
 *   - Mask shape — ggml_soft_max_ext expects [n_kv, n_head_kv, n_tokens]?
 *     The reference passes a 2D mask [n_kv, n_tokens] broadcast across
 *     heads. We do the same.
 *   - Permutation order: ggml_permute(x, 0, 2, 1, 3) is the canonical
 *     "move head axis from dim 1 to dim 2" used everywhere in llama.cpp.
 *
 * DO NOT ship a LoRA trained against this forward until parity_check
 * proves it matches llama_decode bit-for-bit at greedy decode.
 */
static ggml_tensor * build_attn_block(
    ggml_context * ctx,
    const QwenLayer & layer,
    int layer_idx,
    ggml_tensor * input,
    ggml_tensor * positions,
    int n_tokens,
    ggml_tensor * kq_mask,
    const LoraSet * lora)
{
    const bool trace = (layer_idx == 0);
    if (trace) LOGI("attn: enter input ne=[%lld,%lld,%lld]",
                    (long long)input->ne[0], (long long)input->ne[1], (long long)input->ne[2]);
    const float kq_scale = 1.0f / std::sqrt(float(QwenConfig::head_dim));
    const std::string prefix = "blk." + std::to_string(layer_idx) + ".";

    // ── 1. Pre-attention RMSNorm ──────────────────────────────────────
    if (trace) LOGI("attn: rms_norm");
    ggml_tensor * norm = ggml_rms_norm(ctx, input, QwenConfig::rms_eps);
    if (trace) LOGI("attn: mul gamma");
    norm = ggml_mul(ctx, norm, layer.attn_norm);

    // ── 2. Q/K/V projections + bias + LoRA ────────────────────────────
    if (trace) LOGI("attn: Q = mul_mat(attn_q, norm)  weight ne=[%lld,%lld] dtype=%d",
                    (long long)layer.attn_q->ne[0], (long long)layer.attn_q->ne[1], layer.attn_q->type);
    ggml_tensor * Q = ggml_mul_mat(ctx, layer.attn_q, norm);
    Q = apply_lora_delta(ctx, Q, norm, prefix + "attn_q.weight", lora);
    if (layer.attn_q_bias) Q = ggml_add(ctx, Q, layer.attn_q_bias);

    ggml_tensor * K = ggml_mul_mat(ctx, layer.attn_k, norm);
    K = apply_lora_delta(ctx, K, norm, prefix + "attn_k.weight", lora);
    if (layer.attn_k_bias) K = ggml_add(ctx, K, layer.attn_k_bias);

    ggml_tensor * V = ggml_mul_mat(ctx, layer.attn_v, norm);
    V = apply_lora_delta(ctx, V, norm, prefix + "attn_v.weight", lora);
    if (layer.attn_v_bias) V = ggml_add(ctx, V, layer.attn_v_bias);

    if (trace) LOGI("attn: K/V projections done");

    // ── 3. Reshape into per-head layout ────────────────────────────────
    if (trace) LOGI("attn: reshape Q/K/V");
    // Q: [hidden, n_tokens] → [head_dim, n_head, n_tokens]
    // K: [kv_dim, n_tokens] → [head_dim, n_kv_head, n_tokens]
    // V: same layout as K.
    Q = ggml_reshape_3d(ctx, Q, QwenConfig::head_dim, QwenConfig::n_head,    n_tokens);
    K = ggml_reshape_3d(ctx, K, QwenConfig::head_dim, QwenConfig::n_kv_head, n_tokens);
    V = ggml_reshape_3d(ctx, V, QwenConfig::head_dim, QwenConfig::n_kv_head, n_tokens);

    if (trace) LOGI("attn: rope_ext Q");
    // ── 4. RoPE on Q and K ─────────────────────────────────────────────
    // Args from build_qwen2: n_rot=head_dim, mode=0, n_ctx_orig=32768,
    // freq_base=1e6, freq_scale=1.0, ext_factor=0, attn_factor=1,
    // beta_fast=32, beta_slow=1. These are the Qwen 2.5 RoPE constants.
    const int rope_mode = 0; // standard rotary, not NeoX or M-RoPE.
    Q = ggml_rope_ext(
        ctx, Q, positions, /*freq_factors=*/ nullptr,
        QwenConfig::rope_dim, rope_mode, QwenConfig::max_position,
        QwenConfig::rope_theta, /*freq_scale=*/ 1.0f,
        /*ext_factor=*/ 0.0f, /*attn_factor=*/ 1.0f,
        /*beta_fast=*/ 32.0f, /*beta_slow=*/ 1.0f);
    K = ggml_rope_ext(
        ctx, K, positions, /*freq_factors=*/ nullptr,
        QwenConfig::rope_dim, rope_mode, QwenConfig::max_position,
        QwenConfig::rope_theta, 1.0f, 0.0f, 1.0f, 32.0f, 1.0f);

    if (trace) LOGI("attn: rope done, permute Q/K/V");
    // ── 5. Permute for KQ matmul ───────────────────────────────────────
    // ggml_mul_mat semantics: dst[i,j,k] = Σ_d a[d,i,k] * b[d,j,k]
    // We want kq[k_pos, q_pos, head] = Σ_d K[d,k_pos,kvh] * Q[d,q_pos,head]
    // with kvh broadcast across head when n_head_kv < n_head (GQA — at
    // b4524 ggml_mul_mat handles this when the outer dim is a divisor).
    Q = ggml_permute(ctx, Q, 0, 2, 1, 3); // [head_dim, n_tokens, n_head]
    K = ggml_permute(ctx, K, 0, 2, 1, 3); // [head_dim, n_tokens, n_kv_head]
    // V is consumed via mul_mat(V, attn) below. The permute brings n_tokens
    // to ne[0] (the reduction axis), but the resulting strides have
    // nb[0]=row_stride > nb[1]=elem_size, which ggml_mul_mat rejects via
    // its GGML_ASSERT(!ggml_is_transposed(a)) check. Adding ggml_cont
    // materializes a contiguous copy so the mul_mat passes. This matches
    // the convention in llama.cpp's llm_build_kqv which constructs V from
    // a ggml_view_3d with hand-set strides that are already contiguous.
    V = ggml_permute(ctx, V, 1, 2, 0, 3); // [n_tokens, head_dim, n_kv_head]
    V = ggml_cont(ctx, V);                // materialize contiguous copy

    if (trace) LOGI("attn: KQ = mul_mat(K, Q)");
    // ── 6. Attention scores + softmax ──────────────────────────────────
    // KQ: [n_tokens (kv), n_tokens (q), n_head]
    ggml_tensor * KQ = ggml_mul_mat(ctx, K, Q);
    ggml_mul_mat_set_prec(KQ, GGML_PREC_F32); // numerical range guard

    // soft_max_ext fuses scale + mask + softmax. max_alibi_bias=0 for
    // models without ALiBi (Qwen uses RoPE).
    KQ = ggml_soft_max_ext(ctx, KQ, kq_mask, kq_scale, /*max_alibi_bias=*/ 0.0f);

    if (trace) LOGI("attn: soft_max_ext done. KQ ne=[%lld,%lld,%lld] V ne=[%lld,%lld,%lld]",
                    (long long)KQ->ne[0], (long long)KQ->ne[1], (long long)KQ->ne[2],
                    (long long)V->ne[0],  (long long)V->ne[1],  (long long)V->ne[2]);
    // ── 7. Context = V · attn_weights ──────────────────────────────────
    if (trace) LOGI("attn: pre mul_mat(V, KQ)");
    ggml_tensor * KQV = ggml_mul_mat(ctx, V, KQ);
    if (trace) LOGI("attn: post mul_mat");

    // ── 8. Merge heads back to [hidden, n_tokens] ──────────────────────
    if (trace) LOGI("attn: permute KQV");
    KQV = ggml_permute(ctx, KQV, 0, 2, 1, 3); // [head_dim, n_head, n_tokens]
    if (trace) LOGI("attn: cont_2d");
    ggml_tensor * merged = ggml_cont_2d(ctx, KQV, QwenConfig::hidden_dim, n_tokens);

    if (trace) LOGI("attn: KQV done, merging heads");
    // ── 9. Output projection + LoRA + residual ─────────────────────────
    ggml_tensor * out = ggml_mul_mat(ctx, layer.attn_output, merged);
    out = apply_lora_delta(ctx, out, merged, prefix + "attn_output.weight", lora);

    if (trace) LOGI("attn: residual add, returning");
    return ggml_add(ctx, input, out);
}

/**
 * Qwen 2 SwiGLU MLP forward.
 *
 * Mirrors llm_build_ffn at b4524 with type=LLM_FFN_SILU + gate_type=LLM_FFN_PAR
 * (parallel gate/up — both project from the same RMSNormed input, NOT
 * sequentially). The exact ops:
 *
 *   norm  = ffn_norm.weight ⊙ RMSNorm(input)
 *   tmp   = up   · norm                          // [ffn_dim, n_tokens]
 *   cur   = gate · norm                          // [ffn_dim, n_tokens]
 *   cur   = silu(cur)
 *   cur   = cur ⊙ tmp                            // SwiGLU
 *   cur   = down · cur                           // [hidden, n_tokens]
 *   return input + cur                           // residual
 *
 * v0.6 attaches LoRA only to attention projections; MLP LoRA is parked
 * for v0.7 (would 4× the trainable param count). No LoRA injection here.
 */
static ggml_tensor * build_mlp_block(
    ggml_context * ctx,
    const QwenLayer & layer,
    int layer_idx,
    ggml_tensor * input)
{
    (void) layer_idx;

    ggml_tensor * norm = ggml_rms_norm(ctx, input, QwenConfig::rms_eps);
    norm = ggml_mul(ctx, norm, layer.ffn_norm);

    ggml_tensor * tmp = ggml_mul_mat(ctx, layer.ffn_up,   norm); // [ffn, n_tokens]
    ggml_tensor * cur = ggml_mul_mat(ctx, layer.ffn_gate, norm); // [ffn, n_tokens]
    cur = ggml_silu(ctx, cur);
    cur = ggml_mul(ctx, cur, tmp);                               // SwiGLU
    cur = ggml_mul_mat(ctx, layer.ffn_down, cur);                // [hidden, n_tokens]

    return ggml_add(ctx, input, cur);
}

// ─────────────────────────────────────────────────────────────────────────
// Top-level forward
// ─────────────────────────────────────────────────────────────────────────

ggml_tensor * qwen_forward_build(
    QwenModel & model,
    ggml_context * ctx,
    const std::vector<int32_t> & tokens,
    const std::vector<int32_t> & positions,
    const LoraSet * lora,
    bool return_all_positions)
{
    const int n_tokens = (int) tokens.size();
    if (n_tokens == 0 || (int) positions.size() != n_tokens) {
        LOGE("qwen_forward_build: invalid token/position lengths");
        return nullptr;
    }

    // 1. Token embedding lookup. ggml has a dedicated op for this.
    // When the ctx is no_alloc, tok_ids->data is null until the caller
    // runs gallocr_alloc_graph + backend_tensor_set. Skip the memcpy in
    // that mode; the caller fills the inputs post-allocation.
    const bool no_alloc = ggml_get_no_alloc(ctx);
    ggml_tensor * tok_ids = ggml_new_tensor_1d(ctx, GGML_TYPE_I32, n_tokens);
    ggml_set_name(tok_ids, "tokens");
    if (!no_alloc) {
        std::memcpy(tok_ids->data, tokens.data(), n_tokens * sizeof(int32_t));
    }

    ggml_tensor * pos_ids = ggml_new_tensor_1d(ctx, GGML_TYPE_I32, n_tokens);
    ggml_set_name(pos_ids, "positions");
    if (!no_alloc) {
        std::memcpy(pos_ids->data, positions.data(), n_tokens * sizeof(int32_t));
    }

    // X: [hidden, n_tokens]
    ggml_tensor * x = ggml_get_rows(ctx, model.tok_embed, tok_ids);
    ggml_set_name(x, "embed_out");

    // Build the causal mask ONCE — shape [n_tokens, n_tokens] of {0, -inf},
    // shared across all 28 attention blocks via the soft_max_ext mask arg.
    // We allocate it on the same ctx, fill the data in place; the values
    // are graph-constants (don't depend on weights), so a single allocation
    // is correct.
    ggml_tensor * kq_mask = build_causal_mask(ctx, n_tokens);

    // 2. Iterate transformer layers.
    for (int i = 0; i < QwenConfig::n_layer; ++i) {
        LOGI("qwen_forward_build: layer %d/%d", i, QwenConfig::n_layer);
        x = build_attn_block(ctx, model.layers[i], i, x, pos_ids, n_tokens, kq_mask, lora);
        x = build_mlp_block (ctx, model.layers[i], i, x);
    }
    LOGI("qwen_forward_build: layers done, lm_head …");

    // 3. Final RMSNorm + lm_head projection.
    //
    // RMSNorm scaling is `x_i / sqrt(mean(x^2) + eps) * gamma_i`. ggml's
    // ggml_rms_norm does the norm; we then multiply by gamma.
    x = ggml_rms_norm(ctx, x, QwenConfig::rms_eps);
    x = ggml_mul(ctx, x, model.output_norm);
    ggml_set_name(x, "final_norm");

    // lm_head: project [hidden, n_tokens] → [vocab, n_tokens].
    // If lm_head is tied to tok_embed (same pointer), this is the same
    // matrix from step 1 used in the opposite direction — ggml_mul_mat
    // handles the transpose convention.
    ggml_tensor * logits = ggml_mul_mat(ctx, model.lm_head, x);
    ggml_set_name(logits, "logits");

    if (return_all_positions) {
        // logits shape: [vocab, n_tokens] — caller handles selection.
        return logits;
    }
    // Select only the last position's logits — view, no copy.
    ggml_tensor * last = ggml_view_1d(
        ctx, logits, QwenConfig::vocab_size,
        (n_tokens - 1) * logits->nb[1]);
    ggml_set_name(last, "logits_last");
    return last;
}

namespace {

/** Result of argmax + top-3 over a logit vector. */
struct LogitTopK {
    int   id[3] = {-1, -1, -1};
    float v [3] = {-INFINITY, -INFINITY, -INFINITY};
};

/** Tracks the top 3 ids by logit value. Used for richer parity-check
 *  logging so dev can spot "off by one rank" divergence without rerunning. */
LogitTopK top3(const float * logits, int n) {
    LogitTopK out;
    for (int v = 0; v < n; ++v) {
        const float x = logits[v];
        if (x > out.v[0]) {
            out.v[2] = out.v[1]; out.id[2] = out.id[1];
            out.v[1] = out.v[0]; out.id[1] = out.id[0];
            out.v[0] = x;        out.id[0] = v;
        } else if (x > out.v[1]) {
            out.v[2] = out.v[1]; out.id[2] = out.id[1];
            out.v[1] = x;        out.id[1] = v;
        } else if (x > out.v[2]) {
            out.v[2] = x;        out.id[2] = v;
        }
    }
    return out;
}

/**
 * Phase E — gallocr-based greedy decode. Reuses a single backend +
 * gallocr across all steps. Per step:
 *   1. Build graph on a tiny no_alloc=true ctx (only tensor metadata)
 *   2. ggml_gallocr_alloc_graph re-uses its internal buffer optimally
 *   3. Fill named input tensors via backend_tensor_set
 *   4. ggml_backend_graph_compute runs it
 *   5. backend_tensor_get reads the logits
 *
 * Expected to be 5-10× faster than the legacy 4 GB-buffer-per-step path
 * because (a) no per-step malloc churn, (b) buffer reuse across steps,
 * (c) ctx_compute holds only ~10 MB of metadata not 1 GB of activations.
 */
std::vector<int32_t> greedy_decode_qwen_gallocr(
    QwenModel & model,
    const std::vector<int32_t> & prompt_tokens,
    int max_new_tokens,
    std::vector<LogitTopK> * per_step_top3 = nullptr)
{
    // NOTE: name retained for ABI/JNI compat. Implementation reverted from
    // gallocr+backend to the proven no_alloc=false path because gallocr
    // deadlocks on Seeker at compute time (0% CPU, no progress past
    // model-load log). Hardware-validated with this path at N=3 earlier.
    // Phase E gallocr only retained for the training path where memory
    // budget actually matters.
    std::vector<int32_t> generated;
    generated.reserve(max_new_tokens);
    std::vector<int32_t> ctx_tokens = prompt_tokens;

    for (int s = 0; s < max_new_tokens; ++s) {
        LOGI("ours[na] step %d/%d: enter (ctx_tokens=%zu)", s + 1, max_new_tokens, ctx_tokens.size());
        auto t_step = std::chrono::steady_clock::now();
        const int n_tokens = (int) ctx_tokens.size();
        std::vector<int32_t> positions(n_tokens);
        for (int i = 0; i < n_tokens; ++i) positions[i] = i;

        // 384 MB no_alloc=false. Enough for activations at ctx_len<64.
        struct ggml_init_params gp = {
            /*.mem_size   =*/ (size_t) 384 * 1024 * 1024,
            /*.mem_buffer =*/ nullptr,
            /*.no_alloc   =*/ false,
        };
        LOGI("ours[na] step %d: ggml_init …", s + 1);
        ggml_context * gctx = ggml_init(gp);
        if (!gctx) {
            LOGE("greedy_decode_qwen: ggml_init failed at step %d", s);
            break;
        }
        LOGI("ours[na] step %d: ggml_init OK, building forward …", s + 1);

        auto t_build = std::chrono::steady_clock::now();
        ggml_tensor * last_logits = qwen_forward_build(
            model, gctx, ctx_tokens, positions, /*lora=*/ nullptr,
            /*return_all_positions=*/ false);
        if (!last_logits) {
            LOGE("greedy_decode_qwen: forward returned null");
            ggml_free(gctx);
            break;
        }
        LOGI("ours[na] step %d: forward graph built, creating cgraph …", s + 1);

        ggml_cgraph * cgraph = ggml_new_graph(gctx);
        ggml_build_forward_expand(cgraph, last_logits);
        LOGI("ours[na] step %d: cgraph %d nodes, starting compute (6 threads) …",
             s + 1, ggml_graph_n_nodes(cgraph));
        auto t_compute = std::chrono::steady_clock::now();
        ggml_graph_compute_with_ctx(gctx, cgraph, /*n_threads=*/ 6);
        auto t_done = std::chrono::steady_clock::now();
        LOGI("ours[na] step %d: compute done", s + 1);

        const float * logits = (const float *) last_logits->data;
        LogitTopK tk = top3(logits, QwenConfig::vocab_size);
        if (per_step_top3) per_step_top3->push_back(tk);
        generated.push_back(tk.id[0]);
        ctx_tokens.push_back(tk.id[0]);

        const auto ms_init    = std::chrono::duration_cast<std::chrono::milliseconds>(t_build - t_step).count();
        const auto ms_build   = std::chrono::duration_cast<std::chrono::milliseconds>(t_compute - t_build).count();
        const auto ms_compute = std::chrono::duration_cast<std::chrono::milliseconds>(t_done - t_compute).count();
        LOGI("ours[na] step %d/%d ctx=%d: init=%lldms build=%lldms compute=%lldms → tok=%d",
             s + 1, max_new_tokens, n_tokens,
             (long long) ms_init, (long long) ms_build, (long long) ms_compute, tk.id[0]);

        ggml_free(gctx);
    }

    return generated;
}

/** Greedy-decode through llama.cpp's reference path. */
std::vector<int32_t> greedy_decode_llama(
    llama_context * lctx,
    const llama_vocab * vocab,
    const std::vector<int32_t> & prompt_tokens,
    int max_new_tokens)
{
    std::vector<int32_t> generated;
    generated.reserve(max_new_tokens);

    // Greedy sampler — argmax, equivalent to temp=0 / top_k=1.
    llama_sampler * sampler = llama_sampler_chain_init(
        llama_sampler_chain_default_params());
    llama_sampler_chain_add(sampler, llama_sampler_init_greedy());

    // Feed the prompt as a single batch.
    llama_batch batch = llama_batch_get_one(
        const_cast<llama_token *>(prompt_tokens.data()),
        (int32_t) prompt_tokens.size());
    if (llama_decode(lctx, batch) != 0) {
        LOGE("greedy_decode_llama: prompt decode failed");
        llama_sampler_free(sampler);
        return generated;
    }

    int n_cur = (int) prompt_tokens.size();
    for (int s = 0; s < max_new_tokens; ++s) {
        llama_token next = llama_sampler_sample(sampler, lctx, -1);
        if (llama_vocab_is_eog(vocab, next)) break;
        generated.push_back((int32_t) next);

        llama_batch nb = llama_batch_get_one(&next, 1);
        if (llama_decode(lctx, nb) != 0) {
            LOGE("greedy_decode_llama: decode failed at step %d", s);
            break;
        }
        ++n_cur;
    }

    llama_sampler_free(sampler);
    return generated;
}

} // anonymous

int qwen_parity_check(
    const std::string & gguf_path,
    const std::string & prompt,
    int max_tokens)
{
    LOGI("qwen_parity_check: prompt='%s' max_tokens=%d", prompt.c_str(), max_tokens);

    // ── Path B (reference): llama.cpp — also gives us the tokenizer ─────
    llama_model_params mp = llama_model_default_params();
    mp.use_mmap  = true;
    mp.use_mlock = false;
    llama_model * lmodel = llama_model_load_from_file(gguf_path.c_str(), mp);
    if (!lmodel) {
        LOGE("qwen_parity_check: llama_model_load_from_file failed");
        return -1;
    }
    const llama_vocab * vocab = llama_model_get_vocab(lmodel);

    // Tokenize prompt.
    const int prompt_max_toks = (int) prompt.size() + 16;
    std::vector<llama_token> tok_buf(prompt_max_toks);
    int n_prompt = llama_tokenize(
        vocab, prompt.data(), (int) prompt.size(),
        tok_buf.data(), prompt_max_toks,
        /*add_bos=*/ true, /*parse_special=*/ true);
    if (n_prompt < 0) {
        tok_buf.resize(-n_prompt);
        n_prompt = llama_tokenize(
            vocab, prompt.data(), (int) prompt.size(),
            tok_buf.data(), (int) tok_buf.size(), true, true);
        if (n_prompt < 0) {
            LOGE("qwen_parity_check: llama_tokenize failed");
            llama_model_free(lmodel);
            return -1;
        }
    }
    std::vector<int32_t> prompt_tokens(tok_buf.begin(), tok_buf.begin() + n_prompt);
    LOGI("qwen_parity_check: prompt tokenized to %d tokens", n_prompt);

    // Set up an llama_context for the reference path.
    llama_context_params cp = llama_context_default_params();
    cp.n_ctx   = (uint32_t) std::max(4096, n_prompt + max_tokens + 64);
    cp.n_batch = (uint32_t) std::max(512, n_prompt);
    cp.no_perf = true;
    llama_context * lctx = llama_init_from_model(lmodel, cp);
    if (!lctx) {
        LOGE("qwen_parity_check: llama_init_from_model failed");
        llama_model_free(lmodel);
        return -1;
    }

    std::vector<int32_t> ref = greedy_decode_llama(lctx, vocab, prompt_tokens, max_tokens);
    LOGI("qwen_parity_check: reference path produced %zu tokens", ref.size());

    // ── Path A (ours): qwen_forward ────────────────────────────────────
    // Loaded SECOND so we don't peak at 2x model memory during the
    // reference run.
    llama_free(lctx);

    QwenModel model;
    if (!qwen_model_load(model, gguf_path)) {
        LOGE("qwen_parity_check: qwen_model_load failed");
        llama_model_free(lmodel);
        return -1;
    }
    llama_model_free(lmodel);

    std::vector<LogitTopK> ours_top3;
    // Phase E — use the gallocr-based path. ~5-10× faster than the legacy
    // 4 GB-buffer-per-step path because gallocr reuses non-overlapping
    // intermediate buffers within a single contiguous allocation.
    std::vector<int32_t> ours = greedy_decode_qwen_gallocr(model, prompt_tokens, max_tokens, &ours_top3);
    LOGI("qwen_parity_check: our path produced %zu tokens", ours.size());

    qwen_model_free(model);

    // ── Compare token-by-token, with rich divergence logging ────────────
    int matched = 0;
    const int compare_len = (int) std::min(ref.size(), ours.size());
    for (int i = 0; i < compare_len; ++i) {
        if (ref[i] != ours[i]) {
            LOGW("qwen_parity_check: divergence at index %d", i);
            LOGW("  reference: tok=%d", ref[i]);
            if (i < (int) ours_top3.size()) {
                const LogitTopK & t = ours_top3[i];
                LOGW("  ours top-3: [%d %.3f] [%d %.3f] [%d %.3f]",
                     t.id[0], t.v[0], t.id[1], t.v[1], t.id[2], t.v[2]);
                // If the reference is in our top-3, it's likely a tiny
                // numerical drift in the final layer — usually means our
                // forward is structurally correct but f16/q8 quantization
                // is rounding differently. If the reference is far down,
                // there's a deeper structural problem.
                bool ref_in_top3 = (t.id[0] == ref[i] || t.id[1] == ref[i] || t.id[2] == ref[i]);
                LOGW("  reference-in-our-top-3: %s", ref_in_top3 ? "YES" : "NO");
            }
            break;
        }
        ++matched;
    }
    LOGI("qwen_parity_check: %d/%d tokens matched", matched, compare_len);
    return matched;
}

} // namespace ghola
