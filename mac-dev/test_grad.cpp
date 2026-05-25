// Toy LoRA gradient bisection.
//
// Tests progressively add Qwen-style ops between the LoRA injection point
// and the loss. We're hunting which op in our Qwen forward has a backward
// that produces wrong gradients.
//
// Test 1: y = W^T x + scale * B^T (A^T x)  (BASIC — known to pass)
// Test 2: Test 1 + soft_max on the LoRA-perturbed output
// Test 3: Test 1 + reshape_3d + permute + cont (Qwen V branch shape)
// Test 4: Test 1 + a fake attention pattern (Q*K + softmax + V)
// Test 5: Test 1 + RoPE on the LoRA output

#include "ggml.h"
#include "ggml-alloc.h"
#include "ggml-backend.h"
#include "ggml-cpu.h"

#include <cstdio>
#include <cstring>
#include <cmath>
#include <vector>
#include <functional>

constexpr int IN_DIM   = 32;
constexpr int VOCAB    = 10;
constexpr int RANK     = 4;
constexpr int N_SEQ    = 4;
constexpr float SCALE  = 2.0f;

static void fill_pseudo_random(ggml_tensor * t, int seed_base, float scale_) {
    const int64_t n = ggml_nelements(t);
    float * d = (float *) t->data;
    for (int64_t i = 0; i < n; ++i) {
        unsigned u = (unsigned)(i * 2654435761u + seed_base * 19349663u);
        float r = ((u >> 8) & 0xFFFF) / 65535.0f;
        d[i] = scale_ * (2.0f * r - 1.0f);
    }
}

// Each test is a forward-builder closure: (ctx, W, A, B, x, targets) → loss.
using ForwardFn = std::function<ggml_tensor*(ggml_context*, ggml_tensor*, ggml_tensor*, ggml_tensor*, ggml_tensor*, ggml_tensor*)>;

// ── Test 1: BASIC. y = W^T x + scale * B^T (A^T x), then CE(y, targets) ──
static ggml_tensor * fwd_basic(ggml_context * ctx, ggml_tensor * W, ggml_tensor * A, ggml_tensor * B, ggml_tensor * x, ggml_tensor * targets) {
    ggml_tensor * base = ggml_mul_mat(ctx, W, x);            // [VOCAB, N_SEQ]
    ggml_tensor * a_x  = ggml_mul_mat(ctx, A, x);            // [RANK, N_SEQ]
    ggml_tensor * b_a_x = ggml_mul_mat(ctx, B, a_x);         // [VOCAB, N_SEQ]
    ggml_tensor * scaled = ggml_scale(ctx, b_a_x, SCALE);
    ggml_tensor * logits = ggml_add(ctx, base, scaled);
    return ggml_cross_entropy_loss(ctx, logits, targets);
}

// ── Test 2: Add a soft_max between LoRA and loss ──
// (logits → soft_max via "self-attention against itself") This isn't the
// real Qwen pattern but it stresses soft_max backward.
static ggml_tensor * fwd_softmax_passthrough(ggml_context * ctx, ggml_tensor * W, ggml_tensor * A, ggml_tensor * B, ggml_tensor * x, ggml_tensor * targets) {
    ggml_tensor * base = ggml_mul_mat(ctx, W, x);
    ggml_tensor * a_x  = ggml_mul_mat(ctx, A, x);
    ggml_tensor * b_a_x = ggml_mul_mat(ctx, B, a_x);
    ggml_tensor * scaled = ggml_scale(ctx, b_a_x, SCALE);
    ggml_tensor * logits = ggml_add(ctx, base, scaled);

    // Pass through soft_max along dim 0 (per-position softmax)
    // ggml_soft_max scales by inv_sqrt_factor=1 with no mask
    ggml_tensor * sm = ggml_soft_max(ctx, logits);
    // Now CE expects raw logits, but sm is normalized. To make CE valid,
    // log the softmax — but that's a different stress. Simpler: use a
    // tiny linear after softmax to project back to logits space.
    // Even simpler: just multiply by a constant.
    ggml_tensor * out = ggml_scale(ctx, sm, 5.0f);
    return ggml_cross_entropy_loss(ctx, out, targets);
}

// ── Test 3a: reshape only (no permute, no cont) ──
static ggml_tensor * fwd_reshape_only(ggml_context * ctx, ggml_tensor * W, ggml_tensor * A, ggml_tensor * B, ggml_tensor * x, ggml_tensor * targets) {
    ggml_tensor * base = ggml_mul_mat(ctx, W, x);
    ggml_tensor * a_x  = ggml_mul_mat(ctx, A, x);
    ggml_tensor * b_a_x = ggml_mul_mat(ctx, B, a_x);
    ggml_tensor * scaled = ggml_scale(ctx, b_a_x, SCALE);
    ggml_tensor * logits = ggml_add(ctx, base, scaled);
    ggml_tensor * r3 = ggml_reshape_3d(ctx, logits, 5, 2, N_SEQ);
    ggml_tensor * back = ggml_reshape_2d(ctx, r3, VOCAB, N_SEQ);
    return ggml_cross_entropy_loss(ctx, back, targets);
}

// ── Test 3b: reshape + permute (no cont) — won't work because CE needs
// contiguous? Skip if it crashes.
static ggml_tensor * fwd_reshape_permute_only(ggml_context * ctx, ggml_tensor * W, ggml_tensor * A, ggml_tensor * B, ggml_tensor * x, ggml_tensor * targets) {
    ggml_tensor * base = ggml_mul_mat(ctx, W, x);
    ggml_tensor * a_x  = ggml_mul_mat(ctx, A, x);
    ggml_tensor * b_a_x = ggml_mul_mat(ctx, B, a_x);
    ggml_tensor * scaled = ggml_scale(ctx, b_a_x, SCALE);
    ggml_tensor * logits = ggml_add(ctx, base, scaled);
    ggml_tensor * r3 = ggml_reshape_3d(ctx, logits, 5, 2, N_SEQ);
    // permute then permute back, no cont — entirely view-based
    ggml_tensor * p1 = ggml_permute(ctx, r3, 1, 2, 0, 3);
    ggml_tensor * p2 = ggml_permute(ctx, p1, 2, 0, 1, 3); // un-permute
    ggml_tensor * back = ggml_reshape_2d(ctx, p2, VOCAB, N_SEQ);
    return ggml_cross_entropy_loss(ctx, back, targets);
}

// ── Test 3c: reshape + permute + cont (mirrors Qwen V branch) ──
static ggml_tensor * fwd_reshape_permute_cont(ggml_context * ctx, ggml_tensor * W, ggml_tensor * A, ggml_tensor * B, ggml_tensor * x, ggml_tensor * targets) {
    ggml_tensor * base = ggml_mul_mat(ctx, W, x);
    ggml_tensor * a_x  = ggml_mul_mat(ctx, A, x);
    ggml_tensor * b_a_x = ggml_mul_mat(ctx, B, a_x);
    ggml_tensor * scaled = ggml_scale(ctx, b_a_x, SCALE);
    ggml_tensor * logits = ggml_add(ctx, base, scaled);
    ggml_tensor * r3 = ggml_reshape_3d(ctx, logits, 5, 2, N_SEQ);
    // Permute (Qwen-style on V)
    ggml_tensor * p = ggml_permute(ctx, r3, 1, 2, 0, 3);
    ggml_tensor * c = ggml_cont(ctx, p);
    // Reshape contiguous result back to [VOCAB, N_SEQ]
    ggml_tensor * back = ggml_reshape_2d(ctx, c, VOCAB, N_SEQ);
    return ggml_cross_entropy_loss(ctx, back, targets);
}

// ── Test soft_max_ext: with mask + scale (Qwen's attention softmax) ──
static ggml_tensor * fwd_soft_max_ext(ggml_context * ctx, ggml_tensor * W, ggml_tensor * A, ggml_tensor * B, ggml_tensor * x, ggml_tensor * targets) {
    ggml_tensor * base = ggml_mul_mat(ctx, W, x);
    ggml_tensor * a_x  = ggml_mul_mat(ctx, A, x);
    ggml_tensor * b_a_x = ggml_mul_mat(ctx, B, a_x);
    ggml_tensor * scaled = ggml_scale(ctx, b_a_x, SCALE);
    ggml_tensor * logits = ggml_add(ctx, base, scaled);
    // Make a square [N_SEQ, N_SEQ] mask (causal)
    ggml_tensor * mask = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, VOCAB, VOCAB);
    ggml_set_name(mask, "kq_mask_test");
    ggml_set_input(mask);
    // soft_max_ext along dim 0 with the mask + a small scale
    ggml_tensor * sm = ggml_soft_max_ext(ctx, logits, mask, /*scale=*/0.5f, /*max_alibi_bias=*/0.0f);
    ggml_tensor * out = ggml_scale(ctx, sm, 5.0f);
    return ggml_cross_entropy_loss(ctx, out, targets);
}

// ── Test cont after permute (single-cont, Qwen-V style) ──
// Reshape to 3D, permute, cont — then reshape back. This is what Qwen does
// with V (after permute(1,2,0,3) to bring n_tokens to dim 0 then cont).
static ggml_tensor * fwd_cont_after_permute(ggml_context * ctx, ggml_tensor * W, ggml_tensor * A, ggml_tensor * B, ggml_tensor * x, ggml_tensor * targets) {
    ggml_tensor * base = ggml_mul_mat(ctx, W, x);
    ggml_tensor * a_x  = ggml_mul_mat(ctx, A, x);
    ggml_tensor * b_a_x = ggml_mul_mat(ctx, B, a_x);
    ggml_tensor * scaled = ggml_scale(ctx, b_a_x, SCALE);
    ggml_tensor * logits = ggml_add(ctx, base, scaled);       // [10, 4]
    // Reshape [10, 4] → [5, 2, 4]
    ggml_tensor * r3 = ggml_reshape_3d(ctx, logits, 5, 2, N_SEQ);
    // permute(1, 2, 0, 3) → [2, 4, 5]
    ggml_tensor * p  = ggml_permute(ctx, r3, 1, 2, 0, 3);
    // cont
    ggml_tensor * c  = ggml_cont(ctx, p);                    // [2, 4, 5]
    // reshape back to [10, 4] = [5*2, 4]
    ggml_tensor * back = ggml_reshape_2d(ctx, c, VOCAB, N_SEQ);
    return ggml_cross_entropy_loss(ctx, back, targets);
}

// ── Test rms_norm + mul (Qwen's pre-attention norm) ──
static ggml_tensor * fwd_rms_norm(ggml_context * ctx, ggml_tensor * W, ggml_tensor * A, ggml_tensor * B, ggml_tensor * x, ggml_tensor * targets) {
    // Norm comes BEFORE the q proj in Qwen, so we put it on `x` before our matmuls.
    // For this test we'll RMS-norm x, then run the rest.
    ggml_tensor * gamma = ggml_new_tensor_1d(ctx, GGML_TYPE_F32, IN_DIM);
    ggml_set_name(gamma, "rms_gamma_test");
    ggml_set_input(gamma);
    ggml_tensor * nx = ggml_rms_norm(ctx, x, 1e-6f);
    ggml_tensor * nx_g = ggml_mul(ctx, nx, gamma);
    ggml_tensor * base = ggml_mul_mat(ctx, W, nx_g);
    ggml_tensor * a_x  = ggml_mul_mat(ctx, A, nx_g);
    ggml_tensor * b_a_x = ggml_mul_mat(ctx, B, a_x);
    ggml_tensor * scaled = ggml_scale(ctx, b_a_x, SCALE);
    ggml_tensor * logits = ggml_add(ctx, base, scaled);
    return ggml_cross_entropy_loss(ctx, logits, targets);
}

// ── Test 12b: Stacked 2 layers but layer 1 has NO LoRA, just W1·x ──
// Simplest possible stacked: h1 = W1·x, then layer 2 with LoRA on h1.
static ggml_tensor * fwd_stacked_simple(ggml_context * ctx, ggml_tensor * W, ggml_tensor * A, ggml_tensor * B, ggml_tensor * x, ggml_tensor * targets) {
    ggml_tensor * W1 = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, IN_DIM, IN_DIM);
    ggml_set_name(W1, "W1_test");
    ggml_set_input(W1);

    ggml_tensor * h1 = ggml_mul_mat(ctx, W1, x);  // [IN_DIM, N_SEQ]

    ggml_tensor * base = ggml_mul_mat(ctx, W,  h1);
    ggml_tensor * a_x  = ggml_mul_mat(ctx, A,  h1);
    ggml_tensor * b_a_x = ggml_mul_mat(ctx, B, a_x);
    ggml_tensor * scaled = ggml_scale(ctx, b_a_x, SCALE);
    ggml_tensor * logits = ggml_add(ctx, base, scaled);
    return ggml_cross_entropy_loss(ctx, logits, targets);
}

// ── Test 1': basic but with x passed through a no-op cctx tensor first ──
// Goal: see if having x's value in cctx (vs sctx) breaks gradient.
// Add a `zero` tensor and compute x' = x + 0, then use x' in chain.
static ggml_tensor * fwd_basic_via_cctx(ggml_context * ctx, ggml_tensor * W, ggml_tensor * A, ggml_tensor * B, ggml_tensor * x, ggml_tensor * targets) {
    // Make x flow through a graph-built tensor first
    ggml_tensor * zero = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, IN_DIM, N_SEQ);
    ggml_set_name(zero, "zero_test");
    ggml_set_input(zero);
    ggml_tensor * x_cctx = ggml_add(ctx, x, zero);  // x_cctx = x + 0 (in cctx)

    ggml_tensor * base = ggml_mul_mat(ctx, W, x_cctx);
    ggml_tensor * a_x  = ggml_mul_mat(ctx, A, x_cctx);
    ggml_tensor * b_a_x = ggml_mul_mat(ctx, B, a_x);
    ggml_tensor * scaled = ggml_scale(ctx, b_a_x, SCALE);
    ggml_tensor * logits = ggml_add(ctx, base, scaled);
    return ggml_cross_entropy_loss(ctx, logits, targets);
}

// ── Test 11b: get_rows where the emb table is also a param-marked output ──
// (Skipped; just keeping fwd_get_rows below for comparison.)

// ── Test 11: get_rows (token embedding lookup, FIRST op in Qwen forward) ──
// Setup: pretend `x` is an embedding-table-style tensor. Use it via
// get_rows with a token-id tensor as the index.
static ggml_tensor * fwd_get_rows(ggml_context * ctx, ggml_tensor * W, ggml_tensor * A, ggml_tensor * B, ggml_tensor * x, ggml_tensor * targets) {
    // x is [IN_DIM, N_SEQ]. We'll treat its TRANSPOSE as an embedding table
    // [VOCAB_TINY=4, IN_DIM] (so VOCAB_TINY rows of IN_DIM-dim embeddings)
    // and pick 4 of those rows by token-id.
    // Easier: just create an embedding table [IN_DIM, VOCAB_TINY=4] and
    // use get_rows to pick rows.
    ggml_tensor * emb = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, IN_DIM, 4);
    ggml_set_name(emb, "emb_test");
    ggml_set_input(emb);
    ggml_tensor * tokids = ggml_new_tensor_1d(ctx, GGML_TYPE_I32, N_SEQ);
    ggml_set_name(tokids, "tokids");
    ggml_set_input(tokids);

    // get_rows(emb, tokids): pick rows of emb based on tokids → [IN_DIM, N_SEQ]
    ggml_tensor * x_in = ggml_get_rows(ctx, emb, tokids);

    // Then standard LoRA pipeline
    ggml_tensor * base = ggml_mul_mat(ctx, W, x_in);
    ggml_tensor * a_x  = ggml_mul_mat(ctx, A, x_in);
    ggml_tensor * b_a_x = ggml_mul_mat(ctx, B, a_x);
    ggml_tensor * scaled = ggml_scale(ctx, b_a_x, SCALE);
    ggml_tensor * logits = ggml_add(ctx, base, scaled);
    return ggml_cross_entropy_loss(ctx, logits, targets);
}

// ── Test 12: Stacked 2 layers ──
// Two consecutive (W·x + scale·B·(A·x)) blocks before CE.
static ggml_tensor * fwd_stacked_two_layers(ggml_context * ctx, ggml_tensor * W, ggml_tensor * A, ggml_tensor * B, ggml_tensor * x, ggml_tensor * targets) {
    // Layer 1: x → h1 (shape [IN_DIM, N_SEQ])
    // For layer 1 to keep shape [IN_DIM, N_SEQ], we need an intermediate W1 [IN_DIM, IN_DIM] not [IN_DIM, VOCAB].
    // Let's just create a layer1 W and apply LoRA twice using A, B (won't share state but exercises chain).
    ggml_tensor * W1 = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, IN_DIM, IN_DIM);
    ggml_set_name(W1, "W1_test");
    ggml_set_input(W1);
    ggml_tensor * A1 = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, IN_DIM, RANK);
    ggml_set_name(A1, "A1_test");
    ggml_set_input(A1);
    ggml_tensor * B1 = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, RANK, IN_DIM);
    ggml_set_name(B1, "B1_test");
    ggml_set_input(B1);

    // Layer 1: h = W1·x + scale * B1·(A1·x)
    ggml_tensor * h1_base = ggml_mul_mat(ctx, W1, x);
    ggml_tensor * a_x_1   = ggml_mul_mat(ctx, A1, x);
    ggml_tensor * b_a_x_1 = ggml_mul_mat(ctx, B1, a_x_1);
    ggml_tensor * s1      = ggml_scale(ctx, b_a_x_1, SCALE);
    ggml_tensor * h1      = ggml_add(ctx, h1_base, s1);

    // Layer 2: y = W·h1 + scale * B·(A·h1)  [W has shape IN_DIM→VOCAB]
    ggml_tensor * base = ggml_mul_mat(ctx, W,  h1);
    ggml_tensor * a_x  = ggml_mul_mat(ctx, A,  h1);
    ggml_tensor * b_a_x = ggml_mul_mat(ctx, B, a_x);
    ggml_tensor * scaled = ggml_scale(ctx, b_a_x, SCALE);
    ggml_tensor * logits = ggml_add(ctx, base, scaled);
    return ggml_cross_entropy_loss(ctx, logits, targets);
}

// ── Test 10: Two LoRA branches feeding same loss ──
// Uses A and B for branch 1, plus additional A2 and B2 for branch 2.
// y = W^T x + scale*B^T(A^T x) + scale*B2^T(A2^T x)
//
// If our chain has a bug where multiple grads on B don't accumulate
// correctly, this would fail.
static ggml_tensor * fwd_two_loras(ggml_context * ctx, ggml_tensor * W, ggml_tensor * A, ggml_tensor * B, ggml_tensor * x, ggml_tensor * targets) {
    // Create A2, B2 as named inputs we'll fill later (NOT trainable here,
    // just for testing the chain shape)
    // Actually for this to test what we want, A2 and B2 should be CONSTANTS
    // that we initialize. Let's just fill them in the runner.
    ggml_tensor * A2 = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, IN_DIM, RANK); ggml_set_name(A2, "A2_test"); ggml_set_input(A2);
    ggml_tensor * B2 = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, RANK,   VOCAB); ggml_set_name(B2, "B2_test"); ggml_set_input(B2);

    ggml_tensor * base = ggml_mul_mat(ctx, W, x);
    // Branch 1: with our trainable A, B
    ggml_tensor * a1_x = ggml_mul_mat(ctx, A, x);
    ggml_tensor * b1_a1_x = ggml_mul_mat(ctx, B, a1_x);
    ggml_tensor * s1 = ggml_scale(ctx, b1_a1_x, SCALE);
    // Branch 2: with constant A2, B2 (not trainable but in graph)
    ggml_tensor * a2_x = ggml_mul_mat(ctx, A2, x);
    ggml_tensor * b2_a2_x = ggml_mul_mat(ctx, B2, a2_x);
    ggml_tensor * s2 = ggml_scale(ctx, b2_a2_x, SCALE);

    ggml_tensor * logits = ggml_add(ctx, ggml_add(ctx, base, s1), s2);
    return ggml_cross_entropy_loss(ctx, logits, targets);
}

// ── Test 9: Mini-Qwen single attention layer with LoRA on Q ──
// Builds: rms_norm(x)·γ → Q = W_q·norm + scale·B·(A·norm)
//                       → K = W_k·norm
//                       → V = W_v·norm
//                       → reshape to per-head
//                       → RoPE Q, K
//                       → permute Q, K, V
//                       → V = cont(V)
//                       → KQ = K·Q  (attention scores)
//                       → soft_max_ext(KQ, mask, scale)
//                       → KQV = V·KQ
//                       → permute + cont + reshape merge
//                       → out = W_o·KQV
//                       → CE(out, target)
//
// Toy dims: hidden=8, head_dim=4, n_head=2, n_kv_head=2 (no GQA for toy).
// VOCAB=8 (= hidden), N_SEQ=4.
static ggml_tensor * fwd_mini_qwen(ggml_context * ctx, ggml_tensor * W, ggml_tensor * A, ggml_tensor * B, ggml_tensor * x, ggml_tensor * targets) {
    // Reuse: W is W_o (hidden→vocab), but we need W_q, W_k, W_v too.
    // To keep the test signature, store them as named inputs initialized inside.
    // Actually let's just build fresh W_q, W_k, W_v from the existing W via slicing or just reuse W three times.
    // Simpler: just use W as both W_q and the output projection. For attention to be meaningful
    // we DO need three weight matrices. Hack: derive W_k, W_v from W's other regions.
    //
    // Even simpler: create W_q, W_k, W_v as new tensors here.
    constexpr int HIDDEN   = IN_DIM;  // 32, will work as hidden_dim
    constexpr int HEAD_DIM = 8;
    constexpr int N_HEAD   = HIDDEN / HEAD_DIM;  // 4
    constexpr int N_KV     = N_HEAD;             // no GQA for toy

    ggml_tensor * Wq = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, HIDDEN, HIDDEN); ggml_set_name(Wq, "Wq_test"); ggml_set_input(Wq);
    ggml_tensor * Wk = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, HIDDEN, HIDDEN); ggml_set_name(Wk, "Wk_test"); ggml_set_input(Wk);
    ggml_tensor * Wv = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, HIDDEN, HIDDEN); ggml_set_name(Wv, "Wv_test"); ggml_set_input(Wv);
    ggml_tensor * Wo = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, HIDDEN, VOCAB);  ggml_set_name(Wo, "Wo_test"); ggml_set_input(Wo);
    ggml_tensor * gamma = ggml_new_tensor_1d(ctx, GGML_TYPE_F32, HIDDEN); ggml_set_name(gamma, "rms_gamma_test"); ggml_set_input(gamma);
    ggml_tensor * mask  = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, N_SEQ, N_SEQ); ggml_set_name(mask, "kq_mask_test"); ggml_set_input(mask);
    ggml_tensor * positions = ggml_new_tensor_1d(ctx, GGML_TYPE_I32, N_SEQ); ggml_set_name(positions, "positions"); ggml_set_input(positions);

    // 1. RMSNorm(x)·gamma
    ggml_tensor * nx = ggml_rms_norm(ctx, x, 1e-6f);
    ggml_tensor * norm = ggml_mul(ctx, nx, gamma);  // [HIDDEN, N_SEQ]

    // 2. Q = W_q·norm + LoRA on attn_q
    ggml_tensor * Q = ggml_mul_mat(ctx, Wq, norm);  // [HIDDEN, N_SEQ]
    // LoRA on Q: scale * B·(A·norm)
    //   A: [IN_DIM=HIDDEN, RANK]
    //   B: [RANK, VOCAB] — but here we want B with shape [RANK, HIDDEN]
    //   For this test, just use A_dim and B_dim that work: A [HIDDEN, RANK], B [RANK, HIDDEN]
    // BUT our test A is [IN_DIM, RANK] = [HIDDEN, RANK] ✓
    // and B is [RANK, VOCAB] = [RANK, 10]. We need B [RANK, HIDDEN] = [RANK, 32].
    // VOCAB (10) != HIDDEN (32), so B's shape isn't right for this chain.
    //
    // Workaround: don't apply LoRA to Q. Instead, apply LoRA POST-output-projection
    // (to the [VOCAB, N_SEQ] logits). That uses B [RANK, VOCAB] correctly.
    //
    // So the chain is: full Qwen attention + LoRA on output logits.

    ggml_tensor * K = ggml_mul_mat(ctx, Wk, norm);  // [HIDDEN, N_SEQ]
    ggml_tensor * V = ggml_mul_mat(ctx, Wv, norm);  // [HIDDEN, N_SEQ]

    // 3. Reshape into per-head
    Q = ggml_reshape_3d(ctx, Q, HEAD_DIM, N_HEAD, N_SEQ);
    K = ggml_reshape_3d(ctx, K, HEAD_DIM, N_KV,   N_SEQ);
    V = ggml_reshape_3d(ctx, V, HEAD_DIM, N_KV,   N_SEQ);

    // 4. RoPE on Q and K
    Q = ggml_rope_ext(ctx, Q, positions, nullptr, HEAD_DIM, 0, 32768, 1e6f, 1.0f, 0.0f, 1.0f, 32.0f, 1.0f);
    K = ggml_rope_ext(ctx, K, positions, nullptr, HEAD_DIM, 0, 32768, 1e6f, 1.0f, 0.0f, 1.0f, 32.0f, 1.0f);

    // 5. Permute
    Q = ggml_permute(ctx, Q, 0, 2, 1, 3);  // [HEAD_DIM, N_SEQ, N_HEAD]
    K = ggml_permute(ctx, K, 0, 2, 1, 3);  // [HEAD_DIM, N_SEQ, N_KV]
    V = ggml_permute(ctx, V, 1, 2, 0, 3);  // [N_SEQ, HEAD_DIM, N_KV]
    V = ggml_cont(ctx, V);

    // 6. KQ = K·Q  → [N_SEQ_K, N_SEQ_Q, N_HEAD]
    ggml_tensor * KQ = ggml_mul_mat(ctx, K, Q);
    KQ = ggml_soft_max_ext(ctx, KQ, mask, 1.0f / sqrtf(HEAD_DIM), 0.0f);

    // 7. KQV = V·KQ  → [HEAD_DIM, N_SEQ_Q, N_HEAD]
    ggml_tensor * KQV = ggml_mul_mat(ctx, V, KQ);

    // 8. Merge heads back
    KQV = ggml_permute(ctx, KQV, 0, 2, 1, 3);  // [HEAD_DIM, N_HEAD, N_SEQ]
    KQV = ggml_cont(ctx, KQV);
    ggml_tensor * merged = ggml_reshape_2d(ctx, KQV, HIDDEN, N_SEQ);

    // 9. Output projection W_o
    ggml_tensor * out = ggml_mul_mat(ctx, Wo, merged);  // [VOCAB, N_SEQ]

    // 10. LoRA on the output: scale * B·(A·merged)
    //     A: [HIDDEN, RANK] — already correct
    //     B: [RANK, VOCAB] — already correct
    ggml_tensor * a_m = ggml_mul_mat(ctx, A, merged);   // [RANK, N_SEQ]
    ggml_tensor * b_a_m = ggml_mul_mat(ctx, B, a_m);    // [VOCAB, N_SEQ]
    ggml_tensor * scaled = ggml_scale(ctx, b_a_m, SCALE);
    out = ggml_add(ctx, out, scaled);

    return ggml_cross_entropy_loss(ctx, out, targets);
}

// ── Test 4: Fake attention. Q*K^T → softmax → V, like real Qwen ──
// Treats logits as Q. K and V are derived from base too.
static ggml_tensor * fwd_attn_chain(ggml_context * ctx, ggml_tensor * W, ggml_tensor * A, ggml_tensor * B, ggml_tensor * x, ggml_tensor * targets) {
    ggml_tensor * base = ggml_mul_mat(ctx, W, x);            // [VOCAB, N_SEQ]
    ggml_tensor * a_x  = ggml_mul_mat(ctx, A, x);
    ggml_tensor * b_a_x = ggml_mul_mat(ctx, B, a_x);
    ggml_tensor * scaled = ggml_scale(ctx, b_a_x, SCALE);
    ggml_tensor * Q = ggml_add(ctx, base, scaled);           // [VOCAB, N_SEQ] = [10, 4]

    // Use base again (without LoRA) as K and V — to keep the test contained.
    ggml_tensor * K = ggml_mul_mat(ctx, W, x);               // [10, 4]
    ggml_tensor * V = ggml_mul_mat(ctx, W, x);               // [10, 4]

    // Permute Q, K to put N_SEQ in dim 0: [4, 10]
    // (Mirrors Qwen's permute(0, 2, 1, 3) after reshape_3d, but in 2D.)
    Q = ggml_permute(ctx, Q, 1, 0, 2, 3);                    // [4, 10]
    Q = ggml_cont(ctx, Q);
    K = ggml_permute(ctx, K, 1, 0, 2, 3);                    // [4, 10]
    K = ggml_cont(ctx, K);
    V = ggml_permute(ctx, V, 1, 0, 2, 3);                    // [4, 10]
    V = ggml_cont(ctx, V);

    // KQ = mul_mat(K, Q) = K^T Q : [10, 10]
    ggml_tensor * KQ = ggml_mul_mat(ctx, K, Q);              // [10, 10]
    // soft_max along dim 0
    KQ = ggml_soft_max(ctx, KQ);

    // KQV = mul_mat(V, KQ) = V^T KQ : [10, 10]
    ggml_tensor * KQV = ggml_mul_mat(ctx, V, KQ);            // [10, 10]
    // Slice/reshape to [VOCAB, N_SEQ] = [10, 4]
    KQV = ggml_view_2d(ctx, KQV, VOCAB, N_SEQ, KQV->nb[1], 0);
    KQV = ggml_cont(ctx, KQV);
    return ggml_cross_entropy_loss(ctx, KQV, targets);
}

// ── Test 5: RoPE on LoRA output (head_dim=4, n_rot=4, n_heads=2 → vocab=8) ──
// But our VOCAB is fixed at 10. So we'd need to shape it differently.
// Compromise: reshape logits [VOCAB=10, N_SEQ=4] → just use head_dim=10
// (everything in one head), n_rot=10 (rotate all of it).
static ggml_tensor * fwd_rope(ggml_context * ctx, ggml_tensor * W, ggml_tensor * A, ggml_tensor * B, ggml_tensor * x, ggml_tensor * targets) {
    ggml_tensor * base = ggml_mul_mat(ctx, W, x);
    ggml_tensor * a_x  = ggml_mul_mat(ctx, A, x);
    ggml_tensor * b_a_x = ggml_mul_mat(ctx, B, a_x);
    ggml_tensor * scaled = ggml_scale(ctx, b_a_x, SCALE);
    ggml_tensor * logits = ggml_add(ctx, base, scaled);       // [10, 4]

    // [10, 4] → reshape [10, 1, 4] (head_dim=10, n_head=1, n_tokens=4)
    ggml_tensor * r3 = ggml_reshape_3d(ctx, logits, VOCAB, 1, N_SEQ);
    ggml_tensor * positions = ggml_new_tensor_1d(ctx, GGML_TYPE_I32, N_SEQ);
    ggml_set_name(positions, "positions");
    ggml_set_input(positions);
    // n_rot = VOCAB (10) — must be even. 10 works.
    ggml_tensor * roped = ggml_rope_ext(
        ctx, r3, positions, /*freq_factors=*/nullptr,
        /*n_rot=*/VOCAB, /*mode=*/0, /*n_ctx_orig=*/32768,
        /*freq_base=*/1e6f, /*freq_scale=*/1.0f,
        /*ext_factor=*/0.0f, /*attn_factor=*/1.0f,
        /*beta_fast=*/32.0f, /*beta_slow=*/1.0f);
    ggml_tensor * back = ggml_reshape_2d(ctx, roped, VOCAB, N_SEQ);
    return ggml_cross_entropy_loss(ctx, back, targets);
}

// ── Test runner — same scaffolding as before ──
struct TestResult {
    const char * name;
    float numerical;
    float analytic;
    bool signs_agree;
    float rel_err;
};

static TestResult run_test(const char * name, ForwardFn fn) {
    // Static ctx
    ggml_init_params sp = {16*1024*1024, nullptr, false};
    ggml_context * sctx = ggml_init(sp);

    ggml_tensor * W = ggml_new_tensor_2d(sctx, GGML_TYPE_F32, IN_DIM, VOCAB);
    ggml_tensor * A = ggml_new_tensor_2d(sctx, GGML_TYPE_F32, IN_DIM, RANK);
    ggml_tensor * B = ggml_new_tensor_2d(sctx, GGML_TYPE_F32, RANK,   VOCAB);
    ggml_tensor * x       = ggml_new_tensor_2d(sctx, GGML_TYPE_F32, IN_DIM, N_SEQ);
    ggml_tensor * targets = ggml_new_tensor_2d(sctx, GGML_TYPE_F32, VOCAB,  N_SEQ);

    fill_pseudo_random(W, 1, 0.1f);
    fill_pseudo_random(A, 2, 0.1f);
    memset(B->data, 0, ggml_nbytes(B));
    fill_pseudo_random(x, 4, 1.0f);
    memset(targets->data, 0, ggml_nbytes(targets));
    {
        float * td = (float *) targets->data;
        for (int seq = 0; seq < N_SEQ; ++seq) {
            const int tok = (seq * 3) % VOCAB;
            td[(size_t) seq * VOCAB + tok] = 1.0f;
        }
    }

    ggml_set_param(sctx, A);
    ggml_set_param(sctx, B);
    ggml_set_input(x);
    ggml_set_input(targets);

    ggml_backend_t backend = ggml_backend_cpu_init();
    ggml_backend_cpu_set_n_threads(backend, 4);
    // Try the higher-level backend scheduler instead of bare gallocr.
    // backend_sched is what ggml_opt_alloc_graph uses internally and is
    // known to handle forward-backward dependencies correctly.
    ggml_backend_t backends[] = { backend };
    ggml_backend_buffer_type_t buf_types[] = { ggml_backend_cpu_buffer_type() };
    ggml_backend_sched_t sched = ggml_backend_sched_new(
        backends, buf_types, /*n_backends=*/1,
        /*graph_size=*/8192, /*parallel=*/false);
    ggml_gallocr_t galloc = ggml_gallocr_new(ggml_backend_cpu_buffer_type());

    auto eval_loss = [&](float B0_value) -> float {
        float orig = ((float *)B->data)[0];
        ((float *)B->data)[0] = B0_value;

        ggml_init_params cp = {16*1024*1024, nullptr, true};
        ggml_context * cc = ggml_init(cp);
        ggml_tensor * loss = fn(cc, W, A, B, x, targets);
        ggml_cgraph * g = ggml_new_graph_custom(cc, 4096, false);
        ggml_build_forward_expand(g, loss);

        if (!ggml_gallocr_alloc_graph(galloc, g)) {
            printf("eval_loss: gallocr_alloc_graph failed\n");
            ggml_free(cc);
            ((float *)B->data)[0] = orig;
            return NAN;
        }

        if (ggml_tensor * pos = ggml_graph_get_tensor(g, "positions")) {
            int32_t pdata[N_SEQ];
            for (int i = 0; i < N_SEQ; ++i) pdata[i] = i;
            ggml_backend_tensor_set(pos, pdata, 0, sizeof(pdata));
        }
        if (ggml_tensor * tokids = ggml_graph_get_tensor(g, "tokids")) {
            int32_t td[N_SEQ];
            for (int i = 0; i < N_SEQ; ++i) td[i] = i % 4;
            ggml_backend_tensor_set(tokids, td, 0, sizeof(td));
        }
        if (ggml_tensor * mask = ggml_graph_get_tensor(g, "kq_mask_test")) {
            const int64_t M = mask->ne[0];
            const int64_t N = mask->ne[1];
            std::vector<float> md((size_t) M * N);
            for (int64_t q = 0; q < N; ++q)
                for (int64_t k = 0; k < M; ++k)
                    md[(size_t) q * M + k] = (k <= q) ? 0.0f : -INFINITY;
            ggml_backend_tensor_set(mask, md.data(), 0, md.size() * sizeof(float));
        }
        if (ggml_tensor * gamma = ggml_graph_get_tensor(g, "rms_gamma_test")) {
            std::vector<float> gd(IN_DIM);
            for (int i = 0; i < IN_DIM; ++i) gd[i] = 1.0f + 0.01f * ((i * 7) % 100 - 50) / 50.0f;
            ggml_backend_tensor_set(gamma, gd.data(), 0, gd.size() * sizeof(float));
        }
        for (const char * nm : {"Wq_test","Wk_test","Wv_test","Wo_test","A2_test","B2_test","emb_test","W1_test","A1_test","B1_test","zero_test"}) {
            ggml_tensor * t = ggml_graph_get_tensor(g, nm);
            if (!t) continue;
            const size_t n = ggml_nelements(t);
            std::vector<float> wd(n);
            if (strstr(nm, "zero")) {
                std::fill(wd.begin(), wd.end(), 0.0f);
            } else {
                int seed = (int)(nm[0] * 7919 + nm[1] * 31);
                for (size_t i = 0; i < n; ++i) {
                    unsigned u = (unsigned)(i * 2654435761u + seed * 19349663u);
                    float r = ((u >> 8) & 0xFFFF) / 65535.0f;
                    wd[i] = 0.05f * (2.0f * r - 1.0f);
                }
            }
            ggml_backend_tensor_set(t, wd.data(), 0, n * sizeof(float));
        }

        ggml_backend_graph_compute(backend, g);
        float val;
        ggml_backend_tensor_get(loss, &val, 0, sizeof(float));
        ggml_free(cc);
        ((float *)B->data)[0] = orig;
        return val;
    };

    const float eps_fd = 1e-3f;
    const float L_plus  = eval_loss(+eps_fd);
    const float L_minus = eval_loss(-eps_fd);
    const float num_grad = (L_plus - L_minus) / (2.0f * eps_fd);

    // Analytic via build_backward_expand
    memset(B->data, 0, ggml_nbytes(B));
    ggml_init_params cp = {16*1024*1024, nullptr, true};
    ggml_context * cctx = ggml_init(cp);
    ggml_tensor * loss = fn(cctx, W, A, B, x, targets);
    ggml_set_loss(loss);
    ggml_cgraph * cgraph = ggml_new_graph_custom(cctx, 4096, true);
    ggml_build_forward_expand(cgraph, loss);
    ggml_build_backward_expand(sctx, cctx, cgraph, false);
    // Mark the gradient tensors on PARAMS as outputs so backend_sched
    // includes them in execution.
    if (ggml_tensor * gA = ggml_graph_get_grad(cgraph, A)) ggml_set_output(gA);
    if (ggml_tensor * gB = ggml_graph_get_grad(cgraph, B)) ggml_set_output(gB);

    // Use backend_sched instead of bare gallocr — handles forward-backward
    // dependencies correctly.
    ggml_backend_sched_reset(sched);
    if (!ggml_backend_sched_reserve(sched, cgraph)) {
        printf("FAIL sched_reserve for %s\n", name);
        return {name, num_grad, NAN, false, INFINITY};
    }
    if (!ggml_backend_sched_alloc_graph(sched, cgraph)) {
        printf("FAIL sched_alloc for %s\n", name);
        return {name, num_grad, NAN, false, INFINITY};
    }

    if (ggml_tensor * pos2 = ggml_graph_get_tensor(cgraph, "positions")) {
        int32_t pdata[N_SEQ];
        for (int i = 0; i < N_SEQ; ++i) pdata[i] = i;
        ggml_backend_tensor_set(pos2, pdata, 0, sizeof(pdata));
    }
    if (ggml_tensor * tokids = ggml_graph_get_tensor(cgraph, "tokids")) {
        int32_t td[N_SEQ];
        for (int i = 0; i < N_SEQ; ++i) td[i] = i % 4;
        ggml_backend_tensor_set(tokids, td, 0, sizeof(td));
    }
    if (ggml_tensor * mask = ggml_graph_get_tensor(cgraph, "kq_mask_test")) {
        std::vector<float> md(VOCAB * VOCAB);
        for (int q = 0; q < VOCAB; ++q)
            for (int k = 0; k < VOCAB; ++k)
                md[(size_t) q * VOCAB + k] = (k <= q) ? 0.0f : -INFINITY;
        ggml_backend_tensor_set(mask, md.data(), 0, md.size() * sizeof(float));
    }
    if (ggml_tensor * gamma = ggml_graph_get_tensor(cgraph, "rms_gamma_test")) {
        std::vector<float> gd(IN_DIM);
        for (int i = 0; i < IN_DIM; ++i) gd[i] = 1.0f + 0.01f * ((i * 7) % 100 - 50) / 50.0f;
        ggml_backend_tensor_set(gamma, gd.data(), 0, gd.size() * sizeof(float));
    }
    for (const char * nm : {"Wq_test","Wk_test","Wv_test","Wo_test"}) {
        ggml_tensor * t = ggml_graph_get_tensor(cgraph, nm);
        if (!t) continue;
        const size_t n = ggml_nelements(t);
        std::vector<float> wd(n);
        int seed = (nm[1] == 'q' ? 100 : nm[1] == 'k' ? 200 : nm[1] == 'v' ? 300 : 400);
        for (size_t i = 0; i < n; ++i) {
            unsigned u = (unsigned)(i * 2654435761u + seed * 19349663u);
            float r = ((u >> 8) & 0xFFFF) / 65535.0f;
            wd[i] = 0.05f * (2.0f * r - 1.0f);
        }
        ggml_backend_tensor_set(t, wd.data(), 0, n * sizeof(float));
    }

    // CRITICAL: ggml_graph_reset initializes loss grad to 1.0 AND zeros
    // all other grad_accs. The high-level ggml_opt API calls this.
    // Without it, the backward pass sees uninitialized gradient buffers.
    ggml_graph_reset(cgraph);

    ggml_backend_sched_graph_compute(sched, cgraph);

    ggml_tensor * gB = ggml_graph_get_grad(cgraph, B);
    float analytic = 0.0f;
    if (gB) {
        if (gB->buffer) ggml_backend_tensor_get(gB, &analytic, 0, sizeof(float));
        else if (gB->data) analytic = ((float*)gB->data)[0];
        // Diagnostic: log gB info
        if (strstr(name, "get_rows") || strstr(name, "stacked")) {
            printf("  [%s] gB tensor: name='%s' ne=[%lld,%lld] buf=%p data=%p\n",
                   name, ggml_get_name(gB) ? ggml_get_name(gB) : "(none)",
                   (long long) gB->ne[0], (long long) gB->ne[1],
                   (void*)gB->buffer, gB->data);
            // Also log a few more elements
            float gb_more[4] = {0,0,0,0};
            if (gB->buffer) ggml_backend_tensor_get(gB, gb_more, 0, sizeof(gb_more));
            else if (gB->data) memcpy(gb_more, gB->data, sizeof(gb_more));
            printf("  [%s] gB[0..3] = %.4e %.4e %.4e %.4e\n",
                   name, gb_more[0], gb_more[1], gb_more[2], gb_more[3]);
        }
    } else {
        if (strstr(name, "get_rows") || strstr(name, "stacked")) {
            printf("  [%s] gB is NULL\n", name);
        }
    }

    TestResult r;
    r.name = name;
    r.numerical = num_grad;
    r.analytic = analytic;
    r.signs_agree = (num_grad * analytic > 0);
    r.rel_err = fabsf(analytic - num_grad) / fmaxf(fabsf(num_grad), 1e-12f);

    ggml_free(cctx);
    ggml_gallocr_free(galloc);
    ggml_backend_sched_free(sched);
    ggml_backend_free(backend);
    ggml_free(sctx);
    return r;
}

int main() {
    struct { const char * name; ForwardFn fn; } tests[] = {
        {"1.  BASIC",                fwd_basic},
        {"2.  softmax_passthrough",  fwd_softmax_passthrough},
        {"3a. reshape_only",         fwd_reshape_only},
        {"3b. reshape+permute",      fwd_reshape_permute_only},
        {"5.  RoPE",                 fwd_rope},
        {"6.  soft_max_ext (mask)",  fwd_soft_max_ext},
        {"7.  cont_after_permute",   fwd_cont_after_permute},
        {"8.  rms_norm",             fwd_rms_norm},
        {"10. two LoRAs same loss",  fwd_two_loras},
        {"11. get_rows (token emb)",  fwd_get_rows},
        {"12. stacked two layers",    fwd_stacked_two_layers},
        {"1'. basic via cctx x",     fwd_basic_via_cctx},
        {"12b. stacked simple (W1 only)", fwd_stacked_simple},
    };

    printf("%-30s %-13s %-13s %-7s %-12s %s\n",
           "Test", "Numerical", "Analytic", "Signs", "RelErr", "Verdict");
    printf("--------------------------------------------------------------------------------------\n");
    for (auto & t : tests) {
        TestResult r = run_test(t.name, t.fn);
        const char * verdict = (r.signs_agree && r.rel_err < 0.05f) ? "PASS"
                              : (!r.signs_agree)                    ? "SIGN FLIP"
                                                                    : "MAGNITUDE";
        printf("%-30s %+.4e   %+.4e   %-7s %.4e   %s\n",
               r.name, r.numerical, r.analytic,
               r.signs_agree ? "AGREE" : "DIFFER",
               r.rel_err, verdict);
    }
    return 0;
}
