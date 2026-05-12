// v0.6 Phase D implementation — write LoraSet → GGUF adapter on disk.
//
// Strategy: build a fresh gguf_context, populate with kv pairs +
// per-module tensor metadata (downcasted to f16), then gguf_write_to_file.
// We don't allocate a contiguous data blob — gguf_set_tensor_data takes
// a pointer per tensor, so we keep the f16 buffers in a vector that
// outlives the write.

#include "adapter_writer.h"

#include "ggml.h"
#include "gguf.h"

#include <android/log.h>
#include <cstring>
#include <vector>

#define TAG "AdapterWriter"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

namespace ghola {

namespace {

/** Convert an fp32 row to fp16, returning a pinned buffer. The caller
 *  owns the returned vector and must keep it alive until after
 *  gguf_write_to_file completes. */
std::vector<ggml_fp16_t> fp32_to_fp16(const float * src, size_t n) {
    std::vector<ggml_fp16_t> out(n);
    ggml_fp32_to_fp16_row(src, out.data(), (int64_t) n);
    return out;
}

/** Build a transient ggml_context big enough to hold the f16 tensor
 *  metadata stubs (no actual data — we set the data pointer separately
 *  via gguf_set_tensor_data after gguf_add_tensor). */
ggml_context * build_meta_ctx(size_t num_tensors) {
    // ggml_tensor metadata is small (~400 bytes incl name + dims). 2× the
    // tensor count × 1 KB is a safe ceiling for 2 tensors per module ×
    // 128 modules max.
    const size_t bytes = num_tensors * 2 * 1024 + 4096;
    struct ggml_init_params p = {
        /*.mem_size   =*/ bytes,
        /*.mem_buffer =*/ nullptr,
        /*.no_alloc   =*/ true, // we'll point at our own f16 buffers
    };
    return ggml_init(p);
}

} // anonymous

bool write_lora_gguf(
    const LoraSet & set,
    const AdapterMeta & meta,
    const std::string & out_path)
{
    if (set.modules.empty()) {
        LOGE("write_lora_gguf: empty LoraSet");
        return false;
    }

    gguf_context * gguf = gguf_init_empty();
    if (!gguf) {
        LOGE("write_lora_gguf: gguf_init_empty failed");
        return false;
    }

    // KV pairs that llama_adapter_lora_init reads on the inference side.
    gguf_set_val_str(gguf, "general.type",         "adapter");
    gguf_set_val_str(gguf, "general.architecture", meta.architecture.c_str());
    gguf_set_val_str(gguf, "adapter.type",         "lora");
    gguf_set_val_f32(gguf, "adapter.lora.alpha",   set.alpha);
    // v0.6-only provenance fields (Phase G uses these to resume).
    gguf_set_val_i32(gguf, "adapter.training.step",   set.step);
    gguf_set_val_i32(gguf, "adapter.training.epoch",  meta.epoch);
    gguf_set_val_i64(gguf, "adapter.training.run_ms", meta.run_ms);

    // Build f16 stub tensors for every module's A and B, keeping the
    // f16 backing buffers alive in this vector through the write.
    struct StubBuf {
        std::vector<ggml_fp16_t> data;
        ggml_tensor * stub = nullptr; // points into meta_ctx
    };
    std::vector<StubBuf> stubs;
    stubs.reserve(set.modules.size() * 2);

    ggml_context * meta_ctx = build_meta_ctx(set.modules.size() * 2);
    if (!meta_ctx) {
        LOGE("write_lora_gguf: ggml_init for meta_ctx failed");
        gguf_free(gguf);
        return false;
    }

    auto add_tensor = [&](const std::string & name,
                          int d0, int d1,
                          const float * src) -> bool {
        StubBuf buf;
        buf.data = fp32_to_fp16(src, size_t(d0) * size_t(d1));

        // 2D fp16 tensor — same shape as the source. nb[0] = sizeof(fp16),
        // nb[1] = d0 * sizeof(fp16) — let ggml_new_tensor_2d compute it.
        ggml_tensor * stub = ggml_new_tensor_2d(
            meta_ctx, GGML_TYPE_F16, d0, d1);
        if (!stub) {
            LOGE("write_lora_gguf: ggml_new_tensor_2d for '%s' failed", name.c_str());
            return false;
        }
        ggml_set_name(stub, name.c_str());

        gguf_add_tensor(gguf, stub);
        // We hold the f16 bytes; gguf_write_to_file reads from this
        // pointer at write time. Buffer outlives the gguf_write call
        // because `stubs` outlives it.
        gguf_set_tensor_data(gguf, name.c_str(), buf.data.data());

        buf.stub = stub;
        stubs.push_back(std::move(buf));
        return true;
    };

    // Insert in deterministic order so re-runs over the same set produce
    // bit-identical GGUF metadata layout.
    for (const std::string & key : set.order) {
        auto it = set.modules.find(key);
        if (it == set.modules.end()) continue;
        const LoraModule & m = it->second;

        // A: [in_dim, rank]
        const std::string a_name = m.base_tensor_name + ".lora_a";
        if (!add_tensor(a_name, m.in_dim, m.rank, (const float *) m.A->data)) {
            ggml_free(meta_ctx);
            gguf_free(gguf);
            return false;
        }
        // B: [rank, out_dim]
        const std::string b_name = m.base_tensor_name + ".lora_b";
        if (!add_tensor(b_name, m.rank, m.out_dim, (const float *) m.B->data)) {
            ggml_free(meta_ctx);
            gguf_free(gguf);
            return false;
        }
    }

    const bool ok = gguf_write_to_file(gguf, out_path.c_str(), /*only_meta=*/ false);
    if (!ok) {
        LOGE("write_lora_gguf: gguf_write_to_file failed for '%s'", out_path.c_str());
    } else {
        LOGI("write_lora_gguf: wrote %zu modules → %s",
             set.modules.size(), out_path.c_str());
    }

    ggml_free(meta_ctx);
    gguf_free(gguf);
    return ok;
}

// ─── Phase G — loader (inverse of write_lora_gguf) ────────────────────────

namespace {

/** Look up an int kv pair by key, falling back to default_value if missing
 *  or wrong type. (gguf_get_val_i32 would crash on a missing key.) */
int32_t gguf_get_or(gguf_context * g, const char * key, int32_t fallback) {
    const int64_t idx = gguf_find_key(g, key);
    if (idx < 0) return fallback;
    return gguf_get_val_i32(g, idx);
}
int64_t gguf_get_or64(gguf_context * g, const char * key, int64_t fallback) {
    const int64_t idx = gguf_find_key(g, key);
    if (idx < 0) return fallback;
    return gguf_get_val_i64(g, idx);
}

/** Convert a [n] row of fp16 → fp32. */
void fp16_to_fp32(const ggml_fp16_t * src, float * dst, size_t n) {
    ggml_fp16_to_fp32_row(src, dst, (int64_t) n);
}

} // anonymous

bool load_lora_gguf(
    LoraSet & set,
    const std::string & in_path,
    AdapterMeta & out_meta)
{
    if (set.modules.empty()) {
        LOGE("load_lora_gguf: LoraSet not built — call lora_set_build first");
        return false;
    }

    // We need the tensor data, so allocate a ggml_context to back it.
    // Sized loosely from the in-file size; gguf_init_from_file will
    // allocate exactly what's needed.
    ggml_context * read_ctx = nullptr;
    struct gguf_init_params p = {
        /*.no_alloc =*/ false,
        /*.ctx      =*/ &read_ctx,
    };
    gguf_context * g = gguf_init_from_file(in_path.c_str(), p);
    if (!g) {
        LOGE("load_lora_gguf: gguf_init_from_file failed for '%s'", in_path.c_str());
        return false;
    }

    // ── Provenance ────────────────────────────────────────────────────
    out_meta.architecture = "qwen2";
    out_meta.step   = gguf_get_or  (g, "adapter.training.step",   0);
    out_meta.epoch  = gguf_get_or  (g, "adapter.training.epoch",  0);
    out_meta.run_ms = gguf_get_or64(g, "adapter.training.run_ms", 0);

    // Cross-check alpha. If it disagrees, we refuse — the forward branch
    // bakes scale=alpha/rank, so a mismatched alpha changes the math.
    const int64_t alpha_idx = gguf_find_key(g, "adapter.lora.alpha");
    if (alpha_idx >= 0) {
        const float disk_alpha = gguf_get_val_f32(g, alpha_idx);
        if (std::abs(disk_alpha - set.alpha) > 1e-3f) {
            LOGE("load_lora_gguf: alpha mismatch (disk=%.2f, set=%.2f)",
                 disk_alpha, set.alpha);
            gguf_free(g);
            if (read_ctx) ggml_free(read_ctx);
            return false;
        }
    }

    // ── Tensor copy ──────────────────────────────────────────────────
    int n_loaded = 0;
    for (const std::string & key : set.order) {
        auto it = set.modules.find(key);
        if (it == set.modules.end()) continue;
        LoraModule & m = it->second;

        const std::string a_name = m.base_tensor_name + ".lora_a";
        const std::string b_name = m.base_tensor_name + ".lora_b";

        ggml_tensor * disk_a = ggml_get_tensor(read_ctx, a_name.c_str());
        ggml_tensor * disk_b = ggml_get_tensor(read_ctx, b_name.c_str());
        if (!disk_a || !disk_b) {
            LOGE("load_lora_gguf: missing tensor '%s' or '%s'",
                 a_name.c_str(), b_name.c_str());
            gguf_free(g);
            if (read_ctx) ggml_free(read_ctx);
            return false;
        }

        // Verify shapes match (write_lora_gguf writes [in,r] for A and
        // [r,out] for B). If they don't, the run was trained against a
        // different base model or rank — refuse.
        const bool a_shape_ok = (disk_a->ne[0] == m.in_dim  && disk_a->ne[1] == m.rank);
        const bool b_shape_ok = (disk_b->ne[0] == m.rank    && disk_b->ne[1] == m.out_dim);
        if (!a_shape_ok || !b_shape_ok) {
            LOGE("load_lora_gguf: shape mismatch for '%s' "
                 "(A disk=%lldx%lld want=%dx%d; B disk=%lldx%lld want=%dx%d)",
                 m.base_tensor_name.c_str(),
                 (long long) disk_a->ne[0], (long long) disk_a->ne[1], m.in_dim, m.rank,
                 (long long) disk_b->ne[0], (long long) disk_b->ne[1], m.rank, m.out_dim);
            gguf_free(g);
            if (read_ctx) ggml_free(read_ctx);
            return false;
        }

        const size_t a_count = (size_t) m.in_dim * m.rank;
        const size_t b_count = (size_t) m.rank   * m.out_dim;

        // Disk is f16; LoraSet is f32. Convert.
        if (disk_a->type == GGML_TYPE_F16) {
            fp16_to_fp32((const ggml_fp16_t *) disk_a->data,
                         (float *) m.A->data, a_count);
        } else if (disk_a->type == GGML_TYPE_F32) {
            std::memcpy(m.A->data, disk_a->data, a_count * sizeof(float));
        } else {
            LOGE("load_lora_gguf: unsupported A dtype %d for '%s'",
                 disk_a->type, m.base_tensor_name.c_str());
            gguf_free(g);
            if (read_ctx) ggml_free(read_ctx);
            return false;
        }
        if (disk_b->type == GGML_TYPE_F16) {
            fp16_to_fp32((const ggml_fp16_t *) disk_b->data,
                         (float *) m.B->data, b_count);
        } else if (disk_b->type == GGML_TYPE_F32) {
            std::memcpy(m.B->data, disk_b->data, b_count * sizeof(float));
        } else {
            LOGE("load_lora_gguf: unsupported B dtype %d for '%s'",
                 disk_b->type, m.base_tensor_name.c_str());
            gguf_free(g);
            if (read_ctx) ggml_free(read_ctx);
            return false;
        }
        ++n_loaded;
    }

    set.step = out_meta.step;

    LOGI("load_lora_gguf: %d modules loaded from '%s' (step=%d epoch=%d)",
         n_loaded, in_path.c_str(), out_meta.step, out_meta.epoch);

    gguf_free(g);
    if (read_ctx) ggml_free(read_ctx);
    return true;
}

} // namespace ghola
