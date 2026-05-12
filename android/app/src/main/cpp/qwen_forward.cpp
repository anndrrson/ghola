// v0.6 Phase A — Qwen 2.5 1.5B forward in GGML.
//
// STATUS AS OF THIS COMMIT: SKELETON. The file structure, GGUF weight
// loading, and the simple ops (token embedding lookup, RMSNorm wiring,
// final logits projection) are wired. The hard pieces — attention
// (GQA + RoPE + masked softmax) and SwiGLU MLP — are explicitly stubbed
// with `// TODO PHASE A.N` markers pointing at the llama-model.cpp lines
// the implementer should mirror.
//
// What's done in this file:
//   ✅ QwenModel + QwenLayer structs
//   ✅ qwen_model_load — pulls every base tensor out of the GGUF by
//      llama.cpp's naming convention and stores pointers.
//   ✅ qwen_model_free — releases the gguf_context.
//   ✅ qwen_forward_build top-level scaffold: build embedding lookup,
//      iterate layers calling sub-builders, project to vocab via lm_head.
//   ⚠️  build_attn_block — STUBBED. Returns input pass-through. TODO A.1.
//   ⚠️  build_mlp_block — STUBBED. Returns input pass-through. TODO A.2.
//   ⚠️  qwen_parity_check — STUBBED. Returns 0. TODO A.3.
//
// Pre-Phase-B gate: build_attn_block + build_mlp_block + parity check
// must all be real and a 20-token greedy match against llama_decode
// must pass. Until then, qwen_forward_build IS a no-op pass-through
// and we cannot train a usable adapter.

#include "qwen_forward.h"

#include "ggml.h"
#include "gguf.h"

#include <android/log.h>
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
 * Attention block forward + (optional) LoRA injection at q/k/v/o.
 *
 * Reference: llama-model.cpp's Qwen2 build_qwen2 function. Key steps:
 *   1. RMSNorm input with attn_norm.weight (eps=1e-6).
 *   2. q = X · attn_q.weight  + attn_q_bias (if present)
 *      k = X · attn_k.weight  + attn_k_bias
 *      v = X · attn_v.weight  + attn_v_bias
 *      ──── INJECT LoRA on each of q/k/v here:
 *           q += scale * (X · A_q) · B_q   (if lora has "blk.{i}.attn_q.weight")
 *   3. Reshape q to [head_dim, n_head, seq], k/v to [head_dim, n_kv_head, seq].
 *   4. Apply RoPE to q and k via ggml_rope_ext with rope_theta=1e6, dim=128.
 *   5. GQA broadcast: each KV head services (n_head / n_kv_head) = 6 query
 *      heads. ggml_repeat / ggml_view tricks; see llama-model.cpp.
 *   6. attn_scores = q · k^T / sqrt(head_dim)
 *   7. Apply causal mask: scores[i,j] = -inf if j > i.
 *   8. softmax(scores) with ggml_soft_max_ext (handles the mask + scale
 *      in one fused op — preferred for memory).
 *   9. context = attn_weights · v
 *   10. Reshape back to [hidden, seq], project with attn_output.
 *       ──── INJECT LoRA on attn_output here.
 *   11. Residual: return input + projected_context.
 *
 * TODO PHASE A.1: implement steps 1-11 above. Until then this returns
 * the input unchanged — the model will produce garbage logits with this
 * stub in place, which is exactly why qwen_parity_check below MUST be
 * the gate before any training kicks off.
 */
static ggml_tensor * build_attn_block(
    ggml_context * ctx,
    const QwenLayer & layer,
    int layer_idx,
    ggml_tensor * input,
    ggml_tensor * positions,
    const LoraSet * lora)
{
    (void) layer; (void) layer_idx; (void) positions; (void) lora;
    // TODO PHASE A.1: implement the 11-step attention forward documented
    // above. Currently a pass-through — model output is invalid.
    LOGW("build_attn_block: STUB at layer %d (TODO PHASE A.1)", layer_idx);
    return input;
}

/**
 * SwiGLU MLP block forward + (future) LoRA injection.
 *
 * Reference: llama-model.cpp Qwen2 forward. Steps:
 *   1. RMSNorm input with ffn_norm.weight.
 *   2. gate = X · ffn_gate.weight
 *   3. up   = X · ffn_up.weight
 *   4. out  = silu(gate) * up    (SwiGLU activation)
 *   5. out  = out · ffn_down.weight
 *   6. Residual: return input + out.
 *
 * v0.6 attaches LoRA only to attention projections; MLP LoRA is a
 * v0.7 expansion. So no LoRA injection here for now.
 *
 * TODO PHASE A.2: implement steps 1-6.
 */
static ggml_tensor * build_mlp_block(
    ggml_context * ctx,
    const QwenLayer & layer,
    int layer_idx,
    ggml_tensor * input)
{
    (void) layer; (void) layer_idx;
    // TODO PHASE A.2: implement SwiGLU MLP forward.
    LOGW("build_mlp_block: STUB at layer %d (TODO PHASE A.2)", layer_idx);
    return input;
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
    ggml_tensor * tok_ids = ggml_new_tensor_1d(ctx, GGML_TYPE_I32, n_tokens);
    std::memcpy(tok_ids->data, tokens.data(), n_tokens * sizeof(int32_t));
    ggml_set_name(tok_ids, "tokens");

    ggml_tensor * pos_ids = ggml_new_tensor_1d(ctx, GGML_TYPE_I32, n_tokens);
    std::memcpy(pos_ids->data, positions.data(), n_tokens * sizeof(int32_t));
    ggml_set_name(pos_ids, "positions");

    // X: [hidden, n_tokens]
    ggml_tensor * x = ggml_get_rows(ctx, model.tok_embed, tok_ids);
    ggml_set_name(x, "embed_out");

    // 2. Iterate transformer layers.
    for (int i = 0; i < QwenConfig::n_layer; ++i) {
        x = build_attn_block(ctx, model.layers[i], i, x, pos_ids, lora);
        x = build_mlp_block(ctx, model.layers[i], i, x);
    }

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

int qwen_parity_check(
    const std::string & gguf_path,
    const std::string & prompt,
    int max_tokens)
{
    (void) gguf_path; (void) prompt; (void) max_tokens;
    // TODO PHASE A.3: implement the gate.
    //
    // Pseudocode:
    //   1. Load model A via our qwen_model_load.
    //   2. Load model B via the existing llama_jni path (llama_model_load_from_file).
    //   3. Tokenize prompt once.
    //   4. Greedy-decode max_tokens via path A: each step builds a
    //      qwen_forward graph with the running prompt, takes argmax of
    //      last logits, appends.
    //   5. Greedy-decode max_tokens via path B: llama_decode + sampler
    //      chain configured for argmax (temp=0, top_k=1).
    //   6. Return the index of the first divergence (or max_tokens if all match).
    //
    // The implementer should also log per-layer activation statistics
    // (mean/variance/range) between the two paths to localize bugs to a
    // specific layer when divergence happens. llama.cpp lets you dump
    // intermediate tensors via ggml_graph_dump_dot or by setting tensor
    // names + reading them post-compute.
    LOGW("qwen_parity_check: STUB (TODO PHASE A.3)");
    return 0;
}

} // namespace ghola
