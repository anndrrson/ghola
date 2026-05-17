cmake_minimum_required(VERSION 3.22.1)
project(thumper_llama LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_C_STANDARD 11)

# Fetch llama.cpp at a pinned tag.
#
# Why FetchContent and not git submodule: this repo lived with a submodule
# briefly (see commit ea53f9d) — that broke Render Docker builds because
# `git submodule update --init` wasn't part of the cloud image pipeline.
# .dockerignore already excludes android/, so the Render build still never
# sees this; FetchContent only fires when an Android dev (or CI) builds the
# app. The source lands in app/build/_deps/llama-src/ and is reproducible
# from the pinned tag below.
#
# Tag choice: b4524 (Jan 2025). The existing llama_jni.cpp uses APIs that
# only exist at this version or later:
#   - llama_model_load_from_file   (replaces llama_load_model_from_file)
#   - llama_init_from_model         (replaces llama_new_context_with_model)
#   - llama_kv_self_clear           (replaces llama_kv_cache_clear)
#   - llama_sampler_*               (post-Sept 2024 sampler chain API)
#   - llama_vocab_is_eog            (post-2024 helper)
# Bumping the tag forward later is fine; bumping back below b4524 will
# break the JNI surface.
include(FetchContent)

set(LLAMA_BUILD_TESTS    OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_SERVER   OFF CACHE BOOL "" FORCE)
set(LLAMA_CURL           OFF CACHE BOOL "" FORCE)
set(GGML_OPENMP          OFF CACHE BOOL "" FORCE)
set(GGML_LLAMAFILE       OFF CACHE BOOL "" FORCE)
set(BUILD_SHARED_LIBS    OFF CACHE BOOL "" FORCE)
# Originally on for P3's training_pair helpers / arg parsing / chat
# formatting. v0.6's final implementation rolled its own JSON parser
# (load_and_tokenize_pairs) and ChatML string templates, so common is
# unused. Off → faster cmake, smaller .so (~150 KB savings, no link
# of the common static archive).
set(LLAMA_BUILD_COMMON   OFF CACHE BOOL "" FORCE)

FetchContent_Declare(
    llama
    GIT_REPOSITORY https://github.com/ggerganov/llama.cpp.git
    GIT_TAG        b4524
    GIT_SHALLOW    TRUE
)
FetchContent_MakeAvailable(llama)

# Android-specific patch: upstream ggml_abort calls ggml_print_backtrace
# which fork()s and execs gdb/lldb, then waitpid()s. On Android neither
# binary exists, the child fails fast, but the parent's waitpid()
# blocks indefinitely — manifests as a silent hang at 0% CPU on any
# GGML_ASSERT failure. Patch the body of ggml_print_backtrace to be a
# no-op so assertions actually crash visibly via abort().
set(_ggml_c_path "${llama_SOURCE_DIR}/ggml/src/ggml.c")
if(EXISTS "${_ggml_c_path}")
    file(READ "${_ggml_c_path}" _ggml_c_contents)
    if(NOT _ggml_c_contents MATCHES "GHOLA_BWD_TRACE2")
        # Replace the body of the fork-using ggml_print_backtrace with a no-op
        # that just emits "abort backtrace suppressed" to stderr. Crash via
        # abort() — visible in logcat as SIGABRT + the assertion message.
        string(REPLACE
            "static void ggml_print_backtrace(void) {\n    char attach"
            "static void ggml_print_backtrace(void) { /* GHOLA_NO_FORK_BACKTRACE */ fputs(\"abort backtrace suppressed (android)\\n\", stderr); return; char attach"
            _patched "${_ggml_c_contents}")
        # Fix b4524's GGML_OP_MUL backward: when src1 is a broadcast (e.g.
        # RMSNorm gamma [hidden] vs activations [hidden, n_tokens]), the
        # backward does ggml_mul(src1, grad) — but ggml_mul asserts that
        # src1 can repeat to fill src0, which fails when grad is the bigger
        # of the two. Swap to ggml_mul(grad, src1) so the bigger tensor is
        # the destination and the smaller one (src1) gets broadcast. This
        # matches the forward's order and is the standard convention.
        string(REPLACE
            "case GGML_OP_MUL: {\n            if (src0_needs_grads) {\n                ggml_add_or_set(ctx, cgraph, isrc0, ggml_mul(ctx, src1, grad));"
            "case GGML_OP_MUL: {\n            if (src0_needs_grads) { /* GHOLA_MUL_BWD_FIX */\n                struct ggml_tensor * gnorm = ggml_are_same_shape(src0, grad) ? grad : grad;\n                ggml_add_or_set(ctx, cgraph, isrc0, ggml_mul(ctx, gnorm, src1));"
            _patched "${_patched}")
        # Trace which op + tensor shape fails the post-condition asserts.
        # __android_log_print so output lands in logcat (stderr doesn't).
        string(REPLACE
            "    GGML_ASSERT(!src0_needs_grads || ggml_are_same_shape(src0, cgraph->grads[isrc0]));\n    GGML_ASSERT(!src1_needs_grads || ggml_are_same_shape(src1, cgraph->grads[isrc1]));\n    GGML_ASSERT(!src2_needs_grads || ggml_are_same_shape(src2, cgraph->grads[isrc2]));"
            "    /* GHOLA_BWD_TRACE2 */\n    if (src0_needs_grads && !ggml_are_same_shape(src0, cgraph->grads[isrc0])) {\n        __android_log_print(ANDROID_LOG_ERROR, \"GGML_BWD\", \"op=%s SRC0 mismatch src=[%lld %lld %lld %lld] grad=[%lld %lld %lld %lld]\", ggml_op_name(tensor->op), (long long)src0->ne[0], (long long)src0->ne[1], (long long)src0->ne[2], (long long)src0->ne[3], (long long)cgraph->grads[isrc0]->ne[0], (long long)cgraph->grads[isrc0]->ne[1], (long long)cgraph->grads[isrc0]->ne[2], (long long)cgraph->grads[isrc0]->ne[3]);\n    }\n    if (src1_needs_grads && !ggml_are_same_shape(src1, cgraph->grads[isrc1])) {\n        __android_log_print(ANDROID_LOG_ERROR, \"GGML_BWD\", \"op=%s SRC1 mismatch src=[%lld %lld %lld %lld] grad=[%lld %lld %lld %lld]\", ggml_op_name(tensor->op), (long long)src1->ne[0], (long long)src1->ne[1], (long long)src1->ne[2], (long long)src1->ne[3], (long long)cgraph->grads[isrc1]->ne[0], (long long)cgraph->grads[isrc1]->ne[1], (long long)cgraph->grads[isrc1]->ne[2], (long long)cgraph->grads[isrc1]->ne[3]);\n    }\n    GGML_ASSERT(!src0_needs_grads || ggml_are_same_shape(src0, cgraph->grads[isrc0]));\n    GGML_ASSERT(!src1_needs_grads || ggml_are_same_shape(src1, cgraph->grads[isrc1]));\n    GGML_ASSERT(!src2_needs_grads || ggml_are_same_shape(src2, cgraph->grads[isrc2]));"
            _patched "${_patched}")
        # Add #include <android/log.h> at top of ggml.c if not already there
        string(REPLACE
            "// FIXME: required here for quantization functions"
            "#include <android/log.h>  // GHOLA_BWD_TRACE2\n// FIXME: required here for quantization functions"
            _patched "${_patched}")
        file(WRITE "${_ggml_c_path}" "${_patched}")
        message(STATUS "Ghola: patched ggml_print_backtrace + OP_MUL backward")
    endif()
endif()

# JNI bridge — single shared lib that the Kotlin LlamaCpp class loads via
# System.loadLibrary("thumper_llama"). Per the plan we'll add a sibling
# translation unit llama_finetune_jni.cpp in P3 alongside llama_jni.cpp;
# both compile into the same .so so the Kotlin side only needs one
# loadLibrary call.
add_library(thumper_llama SHARED
    llama_jni.cpp
    llama_finetune_jni.cpp
    lora_modules.cpp
    adapter_writer.cpp
    qwen_forward.cpp
    finetune_loop.cpp
)

target_include_directories(thumper_llama PRIVATE
    ${llama_SOURCE_DIR}/include
    ${llama_SOURCE_DIR}/ggml/include
)

target_link_libraries(thumper_llama
    llama
    ggml
    log
    android
)
