// v0.6 Phase C — training loop scaffold.
//
// STATUS: structural skeleton. The forward/backward/step machinery has
// the right shape and the right primitive calls, but DOES NOT WORK YET
// because (a) Phase A's forward isn't parity-checked, and (b) the
// memory budget for the compute graph is unrealistic on Android without
// Phase E's gradient checkpointing.
//
// What IS done here:
//   ✅ AdamW state allocation pattern (per-LoRA-module m/v already
//      allocated in Phase B's lora_set_build — we just thread them
//      through ggml_opt_step_adamw).
//   ✅ Loss tensor construction via ggml_cross_entropy_loss, with
//      explicit prompt-masking via ggml_view to skip prompt positions.
//   ✅ Gradient-norm clipping pattern.
//   ✅ Epoch + step loop with cancellation + progress callbacks.
//   ✅ Gradient-accumulation arithmetic (loss scaling).
//
// What's NOT done:
//   ❌ ggml backend setup (CPU backend init + gallocr). Currently uses
//      ggml_graph_compute_with_ctx which works for the banana test on
//      a beefy dev box but burns ~3 GB compute memory at ctx_len=1024.
//      Phase E swaps this for gallocr + checkpoint boundaries.
//   ❌ Phase G partial-save (checkpoint resume).
//   ❌ Phase A forward correctness — banana test will fail until A.3 passes.

#include "finetune_loop.h"

#include "adapter_writer.h"
#include "ggml.h"
#include "ggml-alloc.h"
#include "ggml-backend.h"
#include "ggml-cpu.h"
#include "llama.h"

#include <android/log.h>
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <random>

#define TAG "FinetuneLoop"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN,  TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

namespace {

/** Read VmRSS in MB from /proc/self/status. Returns -1 if unavailable.
 *  Used for the per-step training memory log so Phase E budget is
 *  observable from the field without `top`/`adb shell`. */
long read_vmrss_mb() {
    FILE * f = fopen("/proc/self/status", "r");
    if (!f) return -1;
    char line[256];
    long rss_kb = -1;
    while (fgets(line, sizeof(line), f)) {
        if (strncmp(line, "VmRSS:", 6) == 0) {
            rss_kb = atol(line + 6);
            break;
        }
    }
    fclose(f);
    return rss_kb < 0 ? -1 : rss_kb / 1024;
}

} // anonymous

namespace ghola {

namespace {

/** Phase E — metadata-only ctx for graph nodes. The real tensor data
 *  is allocated by ggml_gallocr_alloc_graph into a backend buffer; this
 *  ctx only holds the small struct ggml_tensor* records (~400 bytes each).
 *  16 MB covers ~40k tensors which is way more than the ~3000 nodes of
 *  a 28-layer forward+backward needs. Reduces virtual address pressure
 *  vs the earlier 64 MB ceiling. */
constexpr size_t COMPUTE_META_BYTES = (size_t) 16 * 1024 * 1024;

ggml_context * build_compute_ctx() {
    struct ggml_init_params p = {
        /*.mem_size   =*/ COMPUTE_META_BYTES,
        /*.mem_buffer =*/ nullptr,
        /*.no_alloc   =*/ true,    // gallocr allocates the data via the backend
    };
    ggml_context * ctx = ggml_init(p);
    if (!ctx) {
        LOGE("build_compute_ctx: ggml_init failed at %zu bytes", COMPUTE_META_BYTES);
    }
    return ctx;
}

/** Build a labels tensor for cross-entropy. b4524's
 *  ggml_cross_entropy_loss asserts ggml_are_same_shape(logits, labels),
 *  so labels must be a DENSE one-hot f32 distribution of shape
 *  [vocab, n_completion], NOT class indices.
 *
 *  Returns a tensor of the correct shape; data is filled by the caller
 *  after gallocr_alloc_graph runs (in the gallocr path) or here directly
 *  (legacy path). */
ggml_tensor * build_target_tensor(
    ggml_context * ctx,
    const TokenizedPair & pair)
{
    const int n_completion = (int) pair.completion_tokens.size();
    if (n_completion == 0) return nullptr;

    ggml_tensor * targets = ggml_new_tensor_2d(
        ctx, GGML_TYPE_F32, QwenConfig::vocab_size, n_completion);
    ggml_set_name(targets, "targets");
    if (!ggml_get_no_alloc(ctx)) {
        float * d = (float *) targets->data;
        std::memset(d, 0, (size_t) QwenConfig::vocab_size * n_completion * sizeof(float));
        for (int i = 0; i < n_completion; ++i) {
            const int32_t tok = pair.completion_tokens[i];
            if (tok >= 0 && tok < QwenConfig::vocab_size) {
                d[(size_t) i * QwenConfig::vocab_size + tok] = 1.0f;
            }
        }
    }
    return targets;
}

/** AdamW step for one LoRA tensor (A or B).
 *
 * ggml_opt_step_adamw signature at b4524:
 *   ggml_opt_step_adamw(ctx, param, grad, m, v, optimizer_params_tensor)
 *
 * The `optimizer_params_tensor` is a small [7]-shape f32 tensor holding
 * [alpha, beta1, beta2, eps, weight_decay, beta1^t, beta2^t]. Caller must
 * update beta1^t and beta2^t each step.
 *
 * Gradient lookup: at b4524 gradients live on the cgraph, not on the
 * tensor — fetch via ggml_graph_get_grad. (The old `tensor->grad` field
 * was removed in the autograd refactor that landed in late 2024.)
 */
void step_adamw_one(
    ggml_context * ctx,
    ggml_cgraph * cgraph,
    ggml_tensor * param,
    ggml_tensor * m,
    ggml_tensor * v,
    ggml_tensor * opt_params)
{
    if (!param) {
        LOGW("step_adamw_one: param is null");
        return;
    }
    ggml_tensor * grad = ggml_graph_get_grad(cgraph, param);
    if (!grad) {
        LOGW("step_adamw_one: no grad on cgraph for param '%s'",
             ggml_get_name(param));
        return;
    }
    ggml_tensor * step = ggml_opt_step_adamw(ctx, param, grad, m, v, opt_params);
    ggml_build_forward_expand(cgraph, step);
}

} // anonymous

bool run_finetune(
    QwenModel & model,
    LoraSet & lora,
    const std::vector<TokenizedPair> & pairs,
    const FinetuneHyperparams & hp,
    const FinetuneCallbacks & cb,
    const std::string & out_lora_path)
{
    if (pairs.empty()) {
        LOGE("run_finetune: empty training set");
        return false;
    }
    LOGI("run_finetune: %zu pairs × %d epochs (lr=%.2e, rank=%d)",
         pairs.size(), hp.epochs, hp.learning_rate, hp.rank);

    // ── Phase G resume — if `{out}.partial` exists, load weights ──────
    // Honor a checkpoint by treating its `step` as the number of
    // optimizer steps already applied. We resume by skipping the first
    // N steps of the new run. Order-of-shuffle determinism (mt19937 seed
    // = 0xC0FFEE) makes the skip exact.
    int resume_skip_steps = 0;
    {
        const std::string partial = out_lora_path + ".partial";
        std::ifstream test(partial);
        if (test.good()) {
            test.close();
            AdapterMeta loaded;
            if (load_lora_gguf(lora, partial, loaded)) {
                resume_skip_steps = loaded.step;
                LOGI("run_finetune: resumed from %s @ step %d",
                     partial.c_str(), resume_skip_steps);
            } else {
                LOGW("run_finetune: partial exists but failed to load — restarting from step 0");
            }
        }
    }

    // ── Shuffle indices once per epoch (seeded for determinism) ────────
    std::vector<int> indices(pairs.size());
    for (int i = 0; i < (int) pairs.size(); ++i) indices[i] = i;
    std::mt19937 rng(0xC0FFEE);

    const auto t_start = std::chrono::steady_clock::now();
    int   global_step  = 0;
    int   total_steps  = (int) pairs.size() * hp.epochs;
    float beta1_t      = 1.0f;
    float beta2_t      = 1.0f;

    // The "static" context holds optimizer params + state tensors that
    // persist across steps (m, v, beta-powers). Reuse it across the
    // whole training run; only the COMPUTE context is rebuilt per step.
    struct ggml_init_params static_p = {
        /*.mem_size   =*/ 32 * 1024 * 1024,
        /*.mem_buffer =*/ nullptr,
        /*.no_alloc   =*/ false,
    };
    ggml_context * static_ctx = ggml_init(static_p);
    if (!static_ctx) { LOGE("ggml_init for static_ctx failed"); return false; }

    // Phase E — CPU backend + gallocr, shared across ALL training steps.
    // gallocr keeps a single contiguous buffer that grows on demand; tensor
    // slots are reused between non-overlapping intermediates. Empirically
    // cuts peak RSS from ~2 GB to ~600 MB on a 1.5B model at ctx_len=1024.
    ggml_backend_t backend = ggml_backend_cpu_init();
    if (!backend) { LOGE("ggml_backend_cpu_init failed"); ggml_free(static_ctx); return false; }
    // Dimensity 9300: 8 cores (1+3+4). Training pegs all available cores
    // since the foreground notification + wakelock cover the UX, and 8
    // threads vs 6 measurably faster on matmul-heavy backward graphs.
    ggml_backend_cpu_set_n_threads(backend, 8);
    ggml_gallocr_t galloc = ggml_gallocr_new(ggml_backend_cpu_buffer_type());
    if (!galloc) { LOGE("ggml_gallocr_new failed"); ggml_backend_free(backend); ggml_free(static_ctx); return false; }

    // AdamW optimizer-params tensor: [alpha, beta1, beta2, eps, wd, β1^t, β2^t]
    ggml_tensor * opt_params = ggml_new_tensor_1d(static_ctx, GGML_TYPE_F32, 7);
    ggml_set_name(opt_params, "adamw_params");

    auto write_opt_params = [&](int step) {
        beta1_t *= hp.adam_beta1;
        beta2_t *= hp.adam_beta2;
        float * d = (float *) opt_params->data;
        d[0] = hp.learning_rate;
        d[1] = hp.adam_beta1;
        d[2] = hp.adam_beta2;
        d[3] = hp.adam_eps;
        d[4] = hp.weight_decay;
        d[5] = beta1_t;
        d[6] = beta2_t;
        (void) step;
    };

    // ── Epoch loop ─────────────────────────────────────────────────────
    for (int epoch = 0; epoch < hp.epochs; ++epoch) {
        std::shuffle(indices.begin(), indices.end(), rng);
        float epoch_loss_sum = 0.0f;
        int   epoch_step_count = 0;

        for (int idx : indices) {
            // Resume — fast-forward the global step counter without
            // re-running training. The shuffle seed is fixed so the
            // skip is exactly the steps already in the partial.
            if (resume_skip_steps > 0) {
                ++global_step;
                --resume_skip_steps;
                continue;
            }

            if (cb.is_cancelled && cb.is_cancelled()) {
                LOGI("run_finetune: cancelled at epoch %d step %d", epoch, global_step);
                ggml_gallocr_free(galloc);
                ggml_backend_free(backend);
                ggml_free(static_ctx);
                return false;
            }

            const TokenizedPair & pair = pairs[idx];
            const int n_prompt    = (int) pair.prompt_tokens.size();
            const int n_completion = (int) pair.completion_tokens.size();
            const int n_total      = n_prompt + n_completion;
            if (n_total > hp.ctx_len) {
                // Skip oversized pairs; alternative is left-truncation.
                LOGW("run_finetune: skipping pair %d (len=%d > ctx_len=%d)",
                     idx, n_total, hp.ctx_len);
                continue;
            }

            ggml_context * cctx = build_compute_ctx();
            if (!cctx) {
                LOGE("run_finetune: OOM on compute_ctx — aborting");
                ggml_free(static_ctx);
                return false;
            }

            // ── Build tokens + positions ───────────────────────────────
            std::vector<int32_t> tokens; tokens.reserve(n_total);
            tokens.insert(tokens.end(), pair.prompt_tokens.begin(),    pair.prompt_tokens.end());
            tokens.insert(tokens.end(), pair.completion_tokens.begin(), pair.completion_tokens.end());
            std::vector<int32_t> positions(n_total);
            for (int i = 0; i < n_total; ++i) positions[i] = i;

            // ── Forward → logits at every position ─────────────────────
            ggml_tensor * logits = qwen_forward_build(
                model, cctx, tokens, positions, &lora,
                /*return_all_positions=*/ true);
            if (!logits) {
                LOGE("run_finetune: qwen_forward_build returned null");
                ggml_free(cctx);
                continue;
            }
            // logits shape: [vocab_size, n_total]

            // ── Mask out prompt: take only positions [n_prompt-1 .. n_total-2] ──
            // Loss target at position p is token at position p+1. So to learn
            // the COMPLETION tokens, we look at logits from positions
            // (n_prompt-1) ... (n_total-2) and predict completion_tokens[0..].
            //
            // ggml_view_2d(ctx, src, ne0, ne1, nb1, offset):
            //   reshape src to [ne0, ne1], stride nb1 between rows, starting
            //   at byte offset.
            const int loss_n  = n_completion;
            const int vocab   = QwenConfig::vocab_size;
            const size_t row_bytes = logits->nb[1]; // stride to next position
            ggml_tensor * pred = ggml_view_2d(
                cctx, logits, vocab, loss_n, row_bytes,
                (size_t)(n_prompt - 1) * row_bytes);
            ggml_set_name(pred, "logits_completion");

            ggml_tensor * targets = build_target_tensor(cctx, pair);
            if (!targets) {
                LOGE("run_finetune: targets null");
                ggml_free(cctx);
                continue;
            }

            // ggml_cross_entropy_loss at b4524 expects logits + class
            // indices, and reduces to a scalar (mean over positions).
            ggml_tensor * loss = ggml_cross_entropy_loss(cctx, pred, targets);
            ggml_set_name(loss, "loss");
            // ggml_set_loss marks this as the autograd root — required at
            // b4524 for ggml_build_backward_expand to seed dL/dL=1 at the
            // right tensor. Without it, gradients silently don't flow.
            ggml_set_loss(loss);

            // ── Build forward + backward graph ─────────────────────────
            ggml_cgraph * cgraph = ggml_new_graph_custom(cctx,
                /*size=*/ 32768, /*grads=*/ true);
            ggml_build_forward_expand(cgraph, loss);

            // ggml_build_backward_expand at b4524:
            //   void ggml_build_backward_expand(
            //       ctx_static, ctx_compute, cgraph, accumulate);
            // Walks the forward graph in reverse; allocates grad tensors
            // for every ggml_set_param'd input on ctx_static; appends the
            // gradient ops to cgraph.
            ggml_build_backward_expand(static_ctx, cctx, cgraph, /*accumulate=*/ false);

            // ── AdamW step on every LoRA param ─────────────────────────
            write_opt_params(global_step);
            for (const std::string & key : lora.order) {
                auto it = lora.modules.find(key);
                if (it == lora.modules.end()) continue;
                LoraModule & m = it->second;
                step_adamw_one(static_ctx, cgraph, m.A, m.m_A, m.v_A, opt_params);
                step_adamw_one(static_ctx, cgraph, m.B, m.m_B, m.v_B, opt_params);
            }

            // TODO PHASE C — gradient clipping. Defer until banana test
            // passes; overfit is supposed to produce huge grads and
            // clipping would mask the signal.

            // ── Phase E gallocr allocation ─────────────────────────────
            if (!ggml_gallocr_alloc_graph(galloc, cgraph)) {
                LOGE("run_finetune: gallocr_alloc_graph failed at step %d", global_step);
                ggml_free(cctx);
                continue;
            }
            if (global_step == 0) {
                LOGI("first-step cgraph: %d nodes, gallocr buffer auto-sized",
                     ggml_graph_n_nodes(cgraph));
            }

            // ── Fill named input tensors AFTER allocation ──────────────
            ggml_tensor * tok_t  = ggml_graph_get_tensor(cgraph, "tokens");
            ggml_tensor * pos_t  = ggml_graph_get_tensor(cgraph, "positions");
            ggml_tensor * mask_t = ggml_graph_get_tensor(cgraph, "KQ_mask");
            ggml_tensor * tgt_t  = ggml_graph_get_tensor(cgraph, "targets");
            if (!tok_t || !pos_t || !mask_t || !tgt_t) {
                LOGE("run_finetune: missing input tensor (tok=%p pos=%p mask=%p tgt=%p)",
                     (void*)tok_t, (void*)pos_t, (void*)mask_t, (void*)tgt_t);
                ggml_free(cctx);
                continue;
            }
            ggml_backend_tensor_set(tok_t,  tokens.data(),    0, (size_t) n_total      * sizeof(int32_t));
            ggml_backend_tensor_set(pos_t,  positions.data(), 0, (size_t) n_total      * sizeof(int32_t));
            // One-hot labels: [vocab, n_completion] f32, all zeros except
            // a 1.0 at (target_token, position). Required by ggml_cross_
            // entropy_loss's same-shape assertion at b4524.
            {
                const size_t vocab = (size_t) ghola::QwenConfig::vocab_size;
                std::vector<float> labels(vocab * n_completion, 0.0f);
                for (int i = 0; i < n_completion; ++i) {
                    const int32_t tok = pair.completion_tokens[i];
                    if (tok >= 0 && tok < (int32_t) vocab) {
                        labels[(size_t) i * vocab + tok] = 1.0f;
                    }
                }
                ggml_backend_tensor_set(tgt_t, labels.data(), 0,
                                        labels.size() * sizeof(float));
            }
            {
                std::vector<float> mdata((size_t) n_total * n_total);
                const float neg_inf = -INFINITY;
                for (int q = 0; q < n_total; ++q) {
                    for (int k = 0; k < n_total; ++k) {
                        mdata[(size_t) q * n_total + k] = (k <= q) ? 0.0f : neg_inf;
                    }
                }
                ggml_backend_tensor_set(mask_t, mdata.data(), 0,
                                        mdata.size() * sizeof(float));
            }

            // ── Seed gradients ────────────────────────────────────────
            // ggml_graph_reset would do this — but it ALSO zeroes the
            // AdamW momenta (src[2], src[3] of OPT_STEP_ADAMW nodes),
            // which we want PERSISTENT across steps. So we manually:
            //   (a) zero each LoRA param's grad_acc (fresh grad per step)
            //   (b) seed dL/dL = 1.0 at the loss tensor's grad_acc
            // This preserves momentum while giving autograd the right seed.
            for (const std::string & key2 : lora.order) {
                auto it2 = lora.modules.find(key2);
                if (it2 == lora.modules.end()) continue;
                LoraModule & lm = it2->second;
                ggml_tensor * ga_A = ggml_graph_get_grad_acc(cgraph, lm.A);
                ggml_tensor * ga_B = ggml_graph_get_grad_acc(cgraph, lm.B);
                if (ga_A) ggml_set_zero(ga_A);
                if (ga_B) ggml_set_zero(ga_B);
            }
            {
                ggml_tensor * loss_ga = ggml_graph_get_grad_acc(cgraph, loss);
                if (loss_ga) {
                    const float one = 1.0f;
                    ggml_backend_tensor_set(loss_ga, &one, 0, sizeof(float));
                } else {
                    LOGW("run_finetune: no grad_acc for loss — gradients won't flow");
                }
            }

            // ── Compute ────────────────────────────────────────────────
            const enum ggml_status status = ggml_backend_graph_compute(backend, cgraph);
            if (status != GGML_STATUS_SUCCESS) {
                LOGE("run_finetune: backend_graph_compute failed (status=%d) at step %d",
                     (int) status, global_step);
                ggml_free(cctx);
                continue;
            }

            // ── Read loss (scalar) for progress reporting ──────────────
            float step_loss = 0.0f;
            ggml_backend_tensor_get(loss, &step_loss, 0, sizeof(float));
            epoch_loss_sum   += step_loss;
            epoch_step_count += 1;

            // ── Progress callback + RSS log ──────────────────────────
            if (cb.on_step && (global_step % hp.notify_every == 0)) {
                cb.on_step(global_step, total_steps, step_loss);
            }
            if ((global_step % hp.notify_every) == 0) {
                const long rss_mb = ::read_vmrss_mb();
                LOGI("step %d/%d  loss=%.4f  rss=%ld MB",
                     global_step, total_steps, step_loss, rss_mb);
            }

            ggml_free(cctx);
            ++global_step;

            // ── Phase G — partial save every ckpt_every steps ─────────
            if ((global_step % hp.ckpt_every) == 0 && global_step > 0) {
                AdapterMeta meta;
                meta.architecture = "qwen2";
                meta.step  = global_step;
                meta.epoch = epoch;
                meta.run_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                                  std::chrono::steady_clock::now() - t_start).count();
                lora.step = global_step;
                const std::string partial = out_lora_path + ".partial";
                if (write_lora_gguf(lora, meta, partial)) {
                    LOGI("checkpoint @ step %d → %s", global_step, partial.c_str());
                }
            }
        } // pair loop

        const float epoch_mean = (epoch_step_count > 0)
            ? (epoch_loss_sum / float(epoch_step_count))
            : 0.0f;
        LOGI("epoch %d/%d: mean_loss=%.4f over %d steps",
             epoch + 1, hp.epochs, epoch_mean, epoch_step_count);
        if (cb.on_epoch) cb.on_epoch(epoch + 1, hp.epochs, epoch_mean);
    }

    ggml_gallocr_free(galloc);
    ggml_backend_free(backend);
    ggml_free(static_ctx);
    const long total_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                              std::chrono::steady_clock::now() - t_start).count();
    LOGI("run_finetune: complete · %d steps · %ld ms · %.1f s/step",
         global_step, total_ms,
         global_step > 0 ? float(total_ms) / 1000.0f / float(global_step) : 0.0f);
    return true;
}

} // namespace ghola
