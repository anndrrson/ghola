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
# P3 needs llama.cpp's `common` static target (training_pair helpers,
# arg parsing, chat formatting). Turn it on; we link selectively.
set(LLAMA_BUILD_COMMON   ON  CACHE BOOL "" FORCE)

FetchContent_Declare(
    llama
    GIT_REPOSITORY https://github.com/ggerganov/llama.cpp.git
    GIT_TAG        b4524
    GIT_SHALLOW    TRUE
)
FetchContent_MakeAvailable(llama)

# JNI bridge — single shared lib that the Kotlin LlamaCpp class loads via
# System.loadLibrary("thumper_llama"). Per the plan we'll add a sibling
# translation unit llama_finetune_jni.cpp in P3 alongside llama_jni.cpp;
# both compile into the same .so so the Kotlin side only needs one
# loadLibrary call.
add_library(thumper_llama SHARED
    llama_jni.cpp
    llama_finetune_jni.cpp
)

target_include_directories(thumper_llama PRIVATE
    ${llama_SOURCE_DIR}/include
    ${llama_SOURCE_DIR}/ggml/include
    ${llama_SOURCE_DIR}/common
)

target_link_libraries(thumper_llama
    llama
    common
    ggml
    log
    android
)
