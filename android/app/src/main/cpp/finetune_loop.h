// v0.6 Phase C — training loop on top of Phase A's forward + Phase B's LoRA.
//
// Reads JSONL training pairs, runs the forward, builds the backward graph
// via ggml_build_backward_expand, then steps AdamW on the LoRA params.
// The base weights are frozen — only LoRA A/B are param'd in Phase B, so
// ggml's autograd only allocates gradients for A/B.
//
// Phase C's acceptance is the "banana test": train on a synthetic dataset
// where every completion is the single token "banana", verify the model
// overfits within 200 steps. That proves the gradient is flowing end-to-
// end (forward → loss → backward → AdamW → next forward differs).
//
// Reference: tests/test-opt.cpp in the vendored llama.cpp tree at b4524
// is the living example. It's a toy regression problem, not a transformer,
// but it demonstrates the exact primitive-ordering we need:
//   1. ggml_set_param on trainables (we do this in Phase B's lora_set_build).
//   2. Build forward graph in ctx_compute.
//   3. ggml_build_backward_expand(ctx_static, ctx_compute, cgraph, false).
//   4. ggml_graph_compute_with_ctx(ctx, cgraph, n_threads).
//   5. For each param: ggml_opt_step_adamw(ctx, p, p->grad, m, v, hp, step).
//
// Memory: this WILL blow Android's process budget without Phase E's
// gradient checkpointing + gallocr work. For the scaffolded version below
// we use a giant single ggml_init_params buffer (~2 GB) which is fine for
// banana-test dev runs on a Linux machine, but the real Android path must
// route through gallocr — that lives in Phase E and is called out at the
// build_compute_ctx hook below.

#ifndef GHOLA_FINETUNE_LOOP_H
#define GHOLA_FINETUNE_LOOP_H

#include "lora_modules.h"
#include "qwen_forward.h"

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace ghola {

/** Hyperparameter mirror of LlamaFinetune.Hyperparams on the Kotlin side.
 *  Kept as a plain struct so the JNI bridge just copies field-by-field. */
struct FinetuneHyperparams {
    int   rank          = 16;
    float alpha         = 32.0f;
    float learning_rate = 3e-4f;
    int   epochs        = 3;
    int   batch_size    = 1;
    int   ctx_len       = 1024;
    int   grad_accum    = 4;   // simulate batch_size=4 if memory allows
    int   notify_every  = 2;   // steps between progress callbacks (every other step for iter cycles)
    int   ckpt_every    = 50;  // Phase G — partial save cadence

    // AdamW (defaults match the standard PyTorch AdamW recipe). These
    // feed straight into ggml_opt_step_adamw_params.
    float adam_beta1    = 0.9f;
    float adam_beta2    = 0.999f;
    float adam_eps      = 1e-8f;
    float weight_decay  = 0.01f;
    float grad_clip     = 0.1f; // element-wise clamp [-clip, +clip] on LoRA grads. Typical |g| ~1e-3 → 0.1 only activates on softmax-saturation bursts (~1.0 magnitude) that destabilize training at lr ≥ 1e-4.
};

/** A single (prompt, completion) pair after tokenization. */
struct TokenizedPair {
    std::vector<int32_t> prompt_tokens;
    std::vector<int32_t> completion_tokens;
    // Concatenated tokens with prompt_tokens.size() as the split point.
    // Loss is computed only at completion positions.
};

/** Progress callbacks fired from the C++ training loop into Kotlin. The
 *  C++ side does NOT know about JNI — `llama_finetune_jni.cpp` adapts
 *  these to JNI calls. Keep this plain-C-pointer-equivalent. */
struct FinetuneCallbacks {
    /** Per-step. mean_loss is the running mean since the last call. */
    std::function<void(int step, int total_steps, float mean_loss)> on_step;
    /** Per-epoch. mean_loss is the epoch mean. */
    std::function<void(int epoch, int total_epochs, float mean_loss)> on_epoch;
    /** Soft cancel — checked between steps; returns true to abort. */
    std::function<bool()> is_cancelled;
};

/**
 * Run the training loop.
 *
 * @param model            base Qwen model (frozen). qwen_model_load already done.
 * @param lora             trainable LoRA set, weights already initialized.
 * @param pairs            ALL training pairs already tokenized.
 * @param hp               hyperparameters.
 * @param cb               progress + cancel callbacks.
 * @param out_lora_path    on success, this is where Phase D writes the
 *                         adapter. Used by Phase G to checkpoint.
 *
 * @return true on full completion; false on cancel or fatal error. On
 *         success, the LoraSet's A/B tensors hold the trained weights —
 *         the CALLER is responsible for calling write_lora_gguf to
 *         serialize. (We don't write inside this function so Phase G's
 *         partial-save can share the same writer path.)
 *
 * SCAFFOLD STATUS: function body is structural only — see the // PHASE C
 * markers below. The actual forward-backward-step machinery requires the
 * Phase A parity check to pass before it produces usable adapters.
 */
bool run_finetune(
    QwenModel & model,
    LoraSet & lora,
    const std::vector<TokenizedPair> & pairs,
    const FinetuneHyperparams & hp,
    const FinetuneCallbacks & cb,
    const std::string & out_lora_path);

} // namespace ghola

#endif // GHOLA_FINETUNE_LOOP_H
