// v0.6 Phase B — LoRA module data structures.
//
// One LoraModule per (transformer-layer, projection) pair. The training
// loop (Phase C) calls ggml_set_param on the A/B tensors, then forward
// passes inject a `scale * B(A(x))` term alongside each base linear.
// After training, the adapter writer (Phase D) serializes the collection
// to a GGUF file that llama.cpp's llama_adapter_lora_init can load back.
//
// Wiring:
//   - Phase A's qwen_forward.cpp consumes the LoraSet at graph-build time
//     and inserts the LoRA branches into the projection ops.
//   - Phase C's finetune_loop.cpp owns the LoraSet's tensor lifetimes
//     and runs AdamW steps over each module.
//   - Phase D's adapter_writer.cpp serializes a LoraSet to disk.
//   - Phase G's checkpoint code calls Phase D periodically.
//
// Naming convention for the GGUF output:
//   {base_tensor_name}.lora_a  — shape [in_dim, rank]
//   {base_tensor_name}.lora_b  — shape [rank, out_dim]
// where {base_tensor_name} matches llama.cpp's internal tensor naming
// (e.g., "blk.0.attn_q.weight"). The adapter loader on the inference
// side uses this convention; mismatched names → silently ignored LoRA.

#ifndef GHOLA_LORA_MODULES_H
#define GHOLA_LORA_MODULES_H

#include "ggml.h"
#include <string>
#include <unordered_map>
#include <vector>

namespace ghola {

struct LoraModule {
    /** Name of the base linear weight this adapter modifies — must match
     *  llama.cpp's tensor naming (e.g., "blk.7.attn_k.weight"). Used as
     *  the GGUF key prefix on serialization. */
    std::string base_tensor_name;

    /** A: shape [in_dim, rank], fp32. Kaiming-init at construction. */
    ggml_tensor * A = nullptr;

    /** B: shape [rank, out_dim], fp32. Zero-init so initial perturbation
     *  is exactly zero — preserves the base-model invariant at step 0. */
    ggml_tensor * B = nullptr;

    /** AdamW state: first moment m, second moment v. Same shape as A/B,
     *  allocated once per module, reused across optimizer steps. */
    ggml_tensor * m_A = nullptr;
    ggml_tensor * v_A = nullptr;
    ggml_tensor * m_B = nullptr;
    ggml_tensor * v_B = nullptr;

    int   in_dim = 0;
    int   out_dim = 0;
    int   rank = 0;
    float scale = 0.0f;  // alpha / rank; baked into the forward branch.
};

/** Collection of LoRA modules keyed by base tensor name. Owns the
 *  ggml_context that backs the A/B/m/v tensors; that context outlives
 *  any forward graph built against it. */
struct LoraSet {
    /** Backing context for ALL A/B/m/v tensors. Separate from any
     *  forward/backward compute context so the modules survive across
     *  training steps. */
    ggml_context * ctx = nullptr;

    /** Modules indexed by base_tensor_name. Insertion order is preserved
     *  by [order] so adapter serialization is deterministic. */
    std::unordered_map<std::string, LoraModule> modules;
    std::vector<std::string> order;

    /** Hyperparams used to construct this set (also serialized to the
     *  GGUF as adapter.training.* kv pairs, for resume). */
    int   rank = 16;
    float alpha = 32.0f;
    int   step = 0;  // Number of optimizer steps applied so far.
};

/**
 * Build a LoraSet with one module per (layer, target_projection) pair.
 *
 * @param ctx       backing ggml_context the tensors are allocated in.
 *                  Caller must allocate it with enough memory:
 *                  per module: (in*r + r*out) * 4 * 3 == ~144 KB for
 *                  Qwen 2.5 1.5B q/k_proj, 4× for the AdamW state.
 *                  Total for 112 modules ≈ 160 MB.
 *
 * @param num_layers     28 for Qwen 2.5 1.5B
 * @param hidden_dim     1536
 * @param kv_dim         256 (head_dim * num_kv_heads = 128*2)
 * @param target_names   {"attn_q", "attn_k", "attn_v", "attn_output"} typically
 * @param rank           low-rank decomposition rank (16 default)
 * @param alpha          scaling factor (32 default → scale = 2.0)
 *
 * Returns false if any tensor allocation fails (out of ctx memory).
 */
bool lora_set_build(
    LoraSet & set,
    ggml_context * ctx,
    int num_layers,
    int hidden_dim,
    int kv_dim,
    const std::vector<std::string> & target_names,
    int rank,
    float alpha);

/**
 * Zero-init B tensors + Kaiming-init A tensors. Called once after
 * lora_set_build, OR after loading a partial-checkpoint adapter to
 * reset state. The Kaiming variance for A is 1/r — matches the LoRA
 * paper's convention.
 *
 * Init is deterministic given the seed so re-runs are reproducible.
 */
void lora_set_init_weights(LoraSet & set, uint64_t seed);

/** Free the backing context. Tensors are invalidated. */
void lora_set_free(LoraSet & set);

} // namespace ghola

#endif // GHOLA_LORA_MODULES_H
