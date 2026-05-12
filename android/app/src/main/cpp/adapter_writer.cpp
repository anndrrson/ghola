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

} // namespace ghola
