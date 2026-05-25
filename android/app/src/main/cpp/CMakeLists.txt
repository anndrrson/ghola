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

# Solana shielded-pool JNI bridge.
#
# This shared object provides the Android entrypoint used by
# ShieldedPoolNativeProver. It validates that Kotlin is sending the exact
# Rust-shaped TransferWitness JSON before crossing into native code, then
# fails closed until a Groth16 backend and circuit artifacts are linked into
# this target.
add_library(ghola_shielded_pool SHARED
    shielded_pool_jni.cpp
)

target_link_libraries(ghola_shielded_pool
    log
    android
    dl
)

option(GHOLA_SHIELDED_POOL_BUILD_STUB_BACKEND "Build the fail-closed shielded-pool backend stub" ON)
set(GHOLA_SHIELDED_POOL_BACKEND_PREBUILT "" CACHE FILEPATH "Prebuilt arm64-v8a shielded-pool backend .so")

if(GHOLA_SHIELDED_POOL_BACKEND_PREBUILT)
    if(NOT EXISTS "${GHOLA_SHIELDED_POOL_BACKEND_PREBUILT}")
        message(FATAL_ERROR "GHOLA_SHIELDED_POOL_BACKEND_PREBUILT does not exist: ${GHOLA_SHIELDED_POOL_BACKEND_PREBUILT}")
    endif()
    if(CMAKE_NM)
        execute_process(
            COMMAND "${CMAKE_NM}" -D "${GHOLA_SHIELDED_POOL_BACKEND_PREBUILT}"
            OUTPUT_VARIABLE _shielded_pool_backend_symbols
            ERROR_VARIABLE _shielded_pool_backend_nm_error
            RESULT_VARIABLE _shielded_pool_backend_nm_result
        )
        if(NOT _shielded_pool_backend_nm_result EQUAL 0)
            message(FATAL_ERROR "Failed to inspect shielded-pool backend symbols: ${_shielded_pool_backend_nm_error}")
        endif()
        if(NOT _shielded_pool_backend_symbols MATCHES "ghola_shielded_pool_prove_to_file")
            message(FATAL_ERROR "Prebuilt shielded-pool backend must export ghola_shielded_pool_prove_to_file")
        endif()
    else()
        message(WARNING "CMAKE_NM is unavailable; cannot verify prebuilt shielded-pool backend symbols at configure time")
    endif()

    add_library(ghola_shielded_pool_backend SHARED IMPORTED GLOBAL)
    set_target_properties(ghola_shielded_pool_backend PROPERTIES
        IMPORTED_LOCATION "${GHOLA_SHIELDED_POOL_BACKEND_PREBUILT}"
        IMPORTED_SONAME "libghola_shielded_pool_backend.so"
    )
    # Do not link this target into the JNI wrapper. The Rust cdylib currently
    # has no DT_SONAME, and linking it here causes the host absolute path to be
    # embedded in libghola_shielded_pool.so. Gradle packages the backend under
    # jniLibs/arm64-v8a, and the JNI bridge dlopen()s it by basename at runtime.
    message(STATUS "Ghola: using prebuilt Solana shielded-pool backend ${GHOLA_SHIELDED_POOL_BACKEND_PREBUILT}")
elseif(GHOLA_SHIELDED_POOL_BUILD_STUB_BACKEND)
    # Backend ABI smoke target.
    #
    # This is intentionally a fail-closed implementation. It proves that the APK
    # packages and dynamically loads the backend ABI correctly, without pretending
    # to generate a shielded proof. Production builds can replace it by setting
    # GHOLA_SHIELDED_POOL_BACKEND_PREBUILT to an arm64-v8a .so exporting
    # ghola_shielded_pool_prove_to_file.
    add_library(ghola_shielded_pool_backend SHARED
        shielded_pool_backend_stub.cpp
    )

    target_link_libraries(ghola_shielded_pool_backend
        log
        android
    )
else()
    message(FATAL_ERROR "Shielded-pool backend disabled but no GHOLA_SHIELDED_POOL_BACKEND_PREBUILT was provided")
endif()

# ── Phase ζ.0 spike — PowerInfer (Tiiny-AI/SmallThinker) build attempt ──
#
# Goal: prove that a separate `libpowerinfer.so` can be produced alongside
# `libthumper_llama.so` from a pinned Tiiny-AI/PowerInfer commit, without
# breaking the existing llama.cpp b4524 path. Real generation wiring is
# ζ.3 work — this block only validates the COMPILE + LINK path.
#
# Pinned commit: 59df175 ("Merge pull request #272 from Tiiny-AI/Tiiny",
# 2026-01-24). Chosen as the last code-bearing merge before the README-only
# "Launch Tiiny" updates on main. If the build path validates we can revisit
# bumping forward; bumping backward would lose SmallThinker support
# (introduced cef4b86, July 2025).
#
# Symbol-collision strategy: Tiiny-AI/PowerInfer vendors its own complete
# llama.cpp + ggml tree under `smallthinker/{src,ggml,include}`. We CANNOT
# link both into the same .so (duplicate ggml_*, llama_* symbols). The
# attempted resolution is:
#   1. Build PowerInfer as a STANDALONE .so via add_subdirectory pointing at
#      smallthinker/, with its own copies of ggml + llama statically linked
#      into it.
#   2. The Ghola JNI stub (powerinfer_jni.cpp) compiles into a separate
#      `libpowerinfer.so` that wraps the PowerInfer surface.
#   3. Kotlin loads BOTH libthumper_llama.so AND libpowerinfer.so. The two
#      .sos each have their own ggml — that's wasteful (~30-40 MB APK
#      bloat post-stripping) but linker-clean since each .so is dlopen'd
#      with RTLD_LOCAL by default on Android.
#
# Known prerequisites that this CMake CANNOT satisfy on its own (per
# smallthinker/README.md and powerinfer-disk/CMakeLists.txt):
#   - libaio.a must be pre-installed in $NDK/.../sysroot/usr (via
#     `make install prefix=...` from third_part/libaio). powerinfer-disk
#     hard-links `aio` on UNIX with no conditional.
#   - liburing.a same story; powerinfer-cpu hard-links `uring`.
#   - Neither has a CMakeLists.txt — both use hand-rolled Makefile +
#     autoconf-ish configure. ExternalProject_Add could shell out to those
#     but installing into the NDK sysroot mutates the user's NDK and would
#     break for every other Android dev on the team.
#
# If this block fails to configure or link, ζ.0 returns NO-GO and this
# block is deleted in the same commit that documents the failure.
# ζ.0 RESULT: NO-GO. Build fails at the CMake configure step with
# "add_library cannot create target 'llama' because another target with the
# same name already exists" — PowerInfer's vendored llama.cpp tree at
# smallthinker/src declares targets `llama`, `ggml`, `ggml-base`, `ggml-cpu`
# (plus llama-quantize and friends) that ALL collide with the existing
# llama.cpp b4524 FetchContent above. CMake's flat target namespace means
# this cannot be resolved without either:
#   (a) renaming every llama/ggml target in PowerInfer's tree (patches to
#       ~10 CMakeLists.txt — well beyond ζ.0 scope, plus a permanent
#       upstream-rebase tax)
#   (b) moving the PowerInfer build to ExternalProject_Add (runs in its
#       own CMake invocation), then linking the produced .so files. This
#       defers the link step out of Gradle's CMake driver and breaks IDE
#       integration; the .so wouldn't auto-bundle into the APK either.
#   (c) deleting the existing llama.cpp integration entirely — prohibited
#       by ζ.0 scope and would break every other on-device feature.
#
# Plus blockers we never even reached:
#   - libaio + liburing are git submodules with hand-rolled Makefiles, not
#     CMake projects; powerinfer-disk and powerinfer-cpu hard-link them
#     with no conditional. They must be pre-installed into $NDK/sysroot/usr
#     via `make install prefix=...` (mutates the user's NDK).
#   - PowerInfer's smallthinker/src vendors a complete (and modified)
#     llama.cpp + ggml — two .sos would each carry ggml symbols (~30-40 MB
#     APK bloat post-strip).
#
# Default OFF so existing builds keep working. Set to ON only to reproduce
# the configure-step failure.
option(GHOLA_BUILD_POWERINFER "Attempt to build libpowerinfer.so (ζ.0 spike — NO-GO, see comment)" OFF)

if(GHOLA_BUILD_POWERINFER)
    message(STATUS "Ghola ζ.0: attempting PowerInfer FetchContent")

    # PowerInfer's smallthinker root sets LLAMA_CURL=ON by default and
    # builds llama-cli + tests. Turn all of that off before declaring
    # the subdirectory.
    set(LLAMA_CURL              OFF CACHE BOOL "" FORCE)
    set(LLAMA_BUILD_COMMON      OFF CACHE BOOL "" FORCE)
    set(LLAMA_BUILD_TESTS       OFF CACHE BOOL "" FORCE)
    set(LLAMA_BUILD_TOOLS       OFF CACHE BOOL "" FORCE)
    set(LLAMA_BUILD_EXAMPLES    OFF CACHE BOOL "" FORCE)
    set(LLAMA_BUILD_SERVER      OFF CACHE BOOL "" FORCE)
    set(GGML_OPENMP             OFF CACHE BOOL "" FORCE)
    set(GGML_LLAMAFILE          OFF CACHE BOOL "" FORCE)
    set(GGML_CPU_AARCH64        OFF CACHE BOOL "" FORCE)
    set(POWERINFER_NO_FFN_REPACK ON  CACHE BOOL "" FORCE)
    set(POWERINFER_WITH_TRACING  OFF CACHE BOOL "" FORCE)
    set(AZ_ENABLE_PERFETTO       OFF CACHE BOOL "" FORCE)
    set(POWERINFER_ENABLE_TEST   OFF CACHE BOOL "" FORCE)
    # Critical: skip the host-CPU feature probe (which runs the compiler
    # on the build host). On Android NDK cross-compile with this set, the
    # Arch.cmake fast-path is `-march=armv8-a+fp16` (safe for Cortex-A78).
    set(DISABLE_ARM_FEATURE_CHECK ON CACHE BOOL "" FORCE)

    FetchContent_Declare(
        powerinfer
        GIT_REPOSITORY https://github.com/Tiiny-AI/PowerInfer.git
        GIT_TAG        59df17505d981e258a50194597501e0bbd5eaf50
        GIT_SUBMODULES_RECURSE TRUE
        # No GIT_SHALLOW — submodules need full history to checkout pinned SHAs.
    )
    FetchContent_GetProperties(powerinfer)
    if(NOT powerinfer_POPULATED)
        FetchContent_Populate(powerinfer)
        # The smallthinker subdir is the actual build root per upstream README.
        add_subdirectory(${powerinfer_SOURCE_DIR}/smallthinker
                         ${powerinfer_BINARY_DIR}/smallthinker
                         EXCLUDE_FROM_ALL)
    endif()

    # Separate .so for the PowerInfer JNI surface. This MUST be a different
    # target name from `thumper_llama` since both .sos contain ggml symbols.
    add_library(powerinfer SHARED
        powerinfer_jni.cpp
    )

    # The PowerInfer top-level produces a target named `powerinfer-32`
    # (POWERINFER_GROUP_SIZE=32). Link it + its in-tree llama.cpp surface.
    target_link_libraries(powerinfer
        powerinfer-32
        log
        android
    )
endif()
