// v0.6 Phase D — serialize a trained LoraSet to a GGUF adapter file.
//
// The on-disk format must match what llama.cpp's llama_adapter_lora_init
// expects on the inference path; otherwise our trained adapter is
// unreadable by the runtime that has to consume it.
//
// Format spec (reverse-engineered from examples/export-lora/export-lora.cpp
// at tag b4524 + llama-adapter.h struct layout):
//
//   KV pairs (gguf metadata):
//     general.type           = "adapter"            (str)
//     general.architecture   = "qwen2"              (str)
//     adapter.type           = "lora"               (str)
//     adapter.lora.alpha     = 32.0                 (f32)
//     // v0.6-specific provenance — ignored by stock llama.cpp:
//     adapter.training.step  = <int>                (i32, for resume — Phase G)
//     adapter.training.epoch = <int>                (i32)
//     adapter.training.run_ms = <int64>             (i64)
//
//   Tensors:
//     For each LoraModule m in the set:
//       {m.base_tensor_name}.lora_a   shape [in_dim, rank]   dtype f16
//       {m.base_tensor_name}.lora_b   shape [rank, out_dim]  dtype f16
//
// We downcast f32 → f16 on write because (a) llama.cpp's loader expects
// f16 by convention, (b) halving the adapter file size matters for
// device storage (~25MB vs ~50MB at rank 16). The fine-tune accumulates
// gradients in f32 (numerical stability); only the on-disk artifact is
// f16.
//
// Verification gates (Phase D acceptance):
//   1. write_lora_gguf → llama_adapter_lora_init must succeed.
//   2. Round-trip: write, load via llama_adapter_lora_init, manually read
//      the A/B tensors back via the public adapter API — values must
//      match what was written (within f16 quantization).
//   3. applyLora(written_path, 1.0) on the inference JNI must change
//      next-token logits relative to the no-LoRA baseline.

#ifndef GHOLA_ADAPTER_WRITER_H
#define GHOLA_ADAPTER_WRITER_H

#include "lora_modules.h"
#include <string>

namespace ghola {

struct AdapterMeta {
    /** "qwen2" for our v0.6 base. Set on every write for downstream
     *  loaders that filter adapters by architecture. */
    std::string architecture = "qwen2";

    /** Training-progress fields (Phase G uses these for resume). 0 on
     *  first save; incremented as training proceeds. */
    int   step = 0;
    int   epoch = 0;
    long long run_ms = 0;
};

/**
 * Write the LoraSet to a GGUF file at [out_path].
 *
 * @param set     fully-built LoraSet (Phase B). Caller is responsible for
 *                ensuring A/B tensors have current data.
 * @param meta    metadata + provenance fields. alpha is read from the
 *                set, not meta.
 * @param out_path file path. Caller's responsibility to create the
 *                 parent directory.
 *
 * Returns true on success. False on any I/O or serialization failure;
 * the file at out_path is left in an unspecified state (callers should
 * write to a temp path + atomic-rename if the partial-write atom matters
 * — see Phase G).
 */
bool write_lora_gguf(
    const LoraSet & set,
    const AdapterMeta & meta,
    const std::string & out_path);

/**
 * Phase G — load an adapter from disk into an already-built LoraSet, so
 * a training run can resume from a partial checkpoint.
 *
 * Requirements:
 *  - The LoraSet must already be built (lora_set_build called) with the
 *    same target modules and rank as the one being loaded. Mismatched
 *    rank or target set is a fatal error — we don't rebuild the set
 *    here because it would invalidate the AdamW state tensors.
 *  - Tensor dtypes on disk are f16 (per write_lora_gguf); load converts
 *    back to f32 in the LoraSet's tensors. AdamW state (m/v) is NOT
 *    serialized — caller is responsible for either zero-init or
 *    accepting the warmup-cycle cost.
 *
 * @param set             pre-built LoraSet. set.alpha + module shapes must
 *                        match the on-disk adapter.
 * @param in_path         path to the GGUF written by write_lora_gguf.
 * @param out_meta        receives provenance fields read back from the
 *                        adapter (step, epoch, run_ms). Used by Phase F
 *                        to skip already-processed training steps.
 *
 * @return true on success; on false, the LoraSet's tensors are left in
 *         whatever partial state the loader reached and should be
 *         considered untrustworthy — caller should re-init via
 *         lora_set_init_weights and start from step 0.
 */
bool load_lora_gguf(
    LoraSet & set,
    const std::string & in_path,
    AdapterMeta & out_meta);

} // namespace ghola

#endif // GHOLA_ADAPTER_WRITER_H
