cmake_minimum_required(VERSION 3.22.1)
project(thumper_llama)

set(CMAKE_CXX_STANDARD 17)

# Build llama.cpp as static library
set(LLAMA_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(GGML_OPENMP OFF CACHE BOOL "" FORCE)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)

add_subdirectory(llama.cpp)

# JNI bridge shared library
add_library(thumper_llama SHARED llama_jni.cpp)

target_include_directories(thumper_llama PRIVATE
    llama.cpp/include
    llama.cpp/ggml/include
)

target_link_libraries(thumper_llama
    llama
    ggml
    log
    android
)
