// v0.6 Phase A — custom Qwen 2.5 1.5B-Instruct forward pass in GGML.
//
// Why we own this code: the LoRA training loop (Phase C) needs to
// differentiate through the forward pass via ggml_build_backward_expand.
// llama.cpp's llama_decode builds the forward graph internally and does
// NOT expose a hookpoint where we can declare LoRA tensors as trainable.
// So we rebuild Qwen's architecture ourselves on top of ggml primitives,
// freeze the base weights, and inject LoRA branches at each target
// projection.
//
// Reference: examples/training/finetune.cpp was REMOVED upstream
// (commit history pre-2024). The closest living references at our pinned
// tag b4524 are:
//   - src/llama-model.cpp   for "how Qwen's forward is constructed"
//   - tests/test-opt.cpp    for "how the training primitives wire up"
//   - examples/export-lora/ for "what tensor names llama.cpp expects"
//
// Acceptance gate for this TU (do not declare Phase A done until met):
//
//   Greedy-decode 20 tokens from a fixed prompt through:
//     (1) the existing llama_jni inference path (llama_decode-based)
//     (2) our qwen_forward path
//   Token IDs MUST match exactly at greedy. If they don't, Phase B+C
//   will train a LoRA that's nonsense in the inference runtime.

#ifndef GHOLA_QWEN_FORWARD_H
#define GHOLA_QWEN_FORWARD_H

#include "ggml.h"
#include "lora_modules.h"
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace ghola {

/** Qwen 2.5 1.5B-Instruct architecture constants. Sourced from
 *  config.json on the HuggingFace model card; hardcoded here because
 *  v0.6 ships only one base model. A future model swap requires
 *  reading these from the loaded GGUF (gguf_get_val_u32 on each
 *  "qwen2.{key}" kv pair). */
struct QwenConfig {
    static constexpr int    n_layer        = 28;
    static constexpr int    n_head         = 12;
    static constexpr int    n_kv_head      = 2;       // GQA
    static constexpr int    head_dim       = 128;
    static constexpr int    hidden_dim     = 1536;    // n_head * head_dim
    static constexpr int    kv_dim         = 256;     // n_kv_head * head_dim
    static constexpr int    ffn_dim        = 8960;    // SwiGLU intermediate
    static constexpr int    vocab_size     = 151936;
    static constexpr float  rms_eps        = 1e-6f;
    static constexpr float  rope_theta     = 1e6f;
    static constexpr int    rope_dim       = 128;     // head_dim
    static constexpr int    max_position   = 32768;
};

/** Per-layer base weights. Pointers into the loaded GGUF model's
 *  ggml_context — NOT owned here. Frozen during training. */
struct QwenLayer {
    ggml_tensor * attn_norm        = nullptr; // pre-attn RMSNorm γ
    ggml_tensor * attn_q           = nullptr; // [hidden, hidden]
    ggml_tensor * attn_k           = nullptr; // [hidden, kv_dim]
    ggml_tensor * attn_v           = nullptr; // [hidden, kv_dim]
    ggml_tensor * attn_output      = nullptr; // [hidden, hidden]
    ggml_tensor * attn_q_bias      = nullptr; // Qwen2 has bias on q/k/v
    ggml_tensor * attn_k_bias      = nullptr;
    ggml_tensor * attn_v_bias      = nullptr;
    ggml_tensor * ffn_norm         = nullptr; // pre-mlp RMSNorm γ
    ggml_tensor * ffn_gate         = nullptr; // [hidden, ffn]
    ggml_tensor * ffn_up           = nullptr; // [hidden, ffn]
    ggml_tensor * ffn_down         = nullptr; // [ffn, hidden]
};

/** Model + base-weight pointers loaded from GGUF. */
struct QwenModel {
    ggml_context * weights_ctx     = nullptr; // backs all base tensors
    void *         gguf            = nullptr; // gguf_context (cast on use)
    ggml_tensor *  tok_embed       = nullptr; // [vocab, hidden]
    ggml_tensor *  output_norm     = nullptr; // final RMSNorm γ
    ggml_tensor *  lm_head         = nullptr; // [hidden, vocab] — may alias tok_embed (tied)
    std::vector<QwenLayer> layers;            // size = n_layer
};

/**
 * Load Qwen 2.5 1.5B base weights from a GGUF file. Mirrors the layout
 * llama.cpp uses internally; tensor names matched against llama-model.cpp.
 *
 * @param model     receives weight pointers + the backing context.
 * @param gguf_path path to qwen2.5-1.5b-instruct-q8_0.gguf
 * @returns true on success. On failure, model is left in a partial state
 *          and qwen_model_free is safe to call to reclaim.
 *
 * The GGUF is mmap'd via llama.cpp's gguf_init_from_file with no_alloc=
 * false so the tensor data lives in the gguf_context — the caller does
 * not need to copy bytes anywhere.
 */
bool qwen_model_load(QwenModel & model, const std::string & gguf_path);

void qwen_model_free(QwenModel & model);

/**
 * Build a GGML compute graph that runs the Qwen forward pass for a
 * sequence of [n_tokens] tokens. Returns the logits tensor at the final
 * position (shape [vocab_size]) OR all positions if return_all_positions
 * is true (shape [vocab_size, n_tokens]).
 *
 * If [lora] is non-null and matches the model's layer count, LoRA
 * branches are wired into each layer's q/k/v/o projections. With B=0
 * (the init state), the LoRA contribution is identically zero and the
 * forward output equals the bare forward — this is the Phase B
 * acceptance invariant.
 *
 * Caller provides:
 *   @param ctx              compute context (allocated by caller).
 *                           Sized for the forward graph + activations.
 *   @param tokens           input token ids, length [n_tokens].
 *   @param positions        position ids for RoPE, same length.
 *                           Typically just 0..n_tokens-1 for a fresh seq.
 *   @param return_all_positions
 *                           true for training (need every position's
 *                           logits to compute CE loss on the completion).
 *                           false for inference (only the last position).
 *
 * Returns the logits tensor inside [ctx]. Caller is responsible for:
 *   - ggml_build_forward_expand(graph, logits)
 *   - Running the graph (compute backend + gallocr)
 */
ggml_tensor * qwen_forward_build(
    QwenModel & model,
    ggml_context * ctx,
    const std::vector<int32_t> & tokens,
    const std::vector<int32_t> & positions,
    const LoraSet * lora,
    bool return_all_positions);

/**
 * Phase A acceptance test. Greedy-decode N tokens through both this
 * file's forward and llama.cpp's llama_decode. Returns the number of
 * matching tokens at the start of the sequence. N=20 token match is
 * the gate before Phase B begins.
 *
 * This function is the single-source-of-truth for "is Phase A done?"
 * It must be wired and runnable before the Phase A implementation
 * declares itself complete.
 */
int qwen_parity_check(
    const std::string & gguf_path,
    const std::string & prompt,
    int max_tokens);

} // namespace ghola

#endif // GHOLA_QWEN_FORWARD_H
