cmake_minimum_required(VERSION 3.22)
project(ghola_mac_dev LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_C_STANDARD 11)
set(CMAKE_BUILD_TYPE Release)

include(FetchContent)

set(LLAMA_BUILD_TESTS    OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_SERVER   OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_COMMON   OFF CACHE BOOL "" FORCE)
set(LLAMA_CURL           OFF CACHE BOOL "" FORCE)
set(GGML_OPENMP          OFF CACHE BOOL "" FORCE)
set(GGML_LLAMAFILE       OFF CACHE BOOL "" FORCE)
set(BUILD_SHARED_LIBS    OFF CACHE BOOL "" FORCE)
set(GGML_METAL           OFF CACHE BOOL "" FORCE)
set(GGML_ACCELERATE      OFF CACHE BOOL "" FORCE)

FetchContent_Declare(
    llama
    GIT_REPOSITORY https://github.com/ggerganov/llama.cpp.git
    GIT_TAG        b4524
    GIT_SHALLOW    TRUE
)
FetchContent_MakeAvailable(llama)

add_executable(test_grad test_grad.cpp)
target_include_directories(test_grad PRIVATE
    ${llama_SOURCE_DIR}/ggml/include
)
target_link_libraries(test_grad ggml)
