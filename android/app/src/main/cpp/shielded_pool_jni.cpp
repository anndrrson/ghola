#include <jni.h>
#include <android/log.h>
#include <cstdio>
#include <cstring>
#include <dlfcn.h>
#include <fstream>
#include <sstream>
#include <string>

#include "shielded_pool_backend.h"

#define SP_TAG "ShieldedPoolProver"
#define SP_LOGW(...) __android_log_print(ANDROID_LOG_WARN, SP_TAG, __VA_ARGS__)
#define SP_LOGI(...) __android_log_print(ANDROID_LOG_INFO, SP_TAG, __VA_ARGS__)

namespace {

std::string jstring_to_string(JNIEnv *env, jstring s) {
    if (!s) return "";
    const char *raw = env->GetStringUTFChars(s, nullptr);
    if (!raw) return "";
    std::string out(raw);
    env->ReleaseStringUTFChars(s, raw);
    return out;
}

void throw_illegal_state(JNIEnv *env, const char *message) {
    jclass klass = env->FindClass("java/lang/IllegalStateException");
    if (klass) env->ThrowNew(klass, message);
}

bool contains(const std::string &haystack, const char *needle) {
    return haystack.find(needle) != std::string::npos;
}

bool has_transfer_witness_shape(const std::string &json) {
    return contains(json, "\"input_notes\"") &&
           contains(json, "\"input_paths\"") &&
           contains(json, "\"input_indices\"") &&
           contains(json, "\"output_notes\"") &&
           contains(json, "\"spending_key\"") &&
           contains(json, "\"public_amount\"") &&
           contains(json, "\"asset_id\"") &&
           contains(json, "\"ext_data_hash\"");
}

bool file_exists(const std::string &path) {
    FILE *f = std::fopen(path.c_str(), "rb");
    if (!f) return false;
    std::fclose(f);
    return true;
}

std::string read_file(const std::string &path) {
    std::ifstream in(path, std::ios::binary);
    std::ostringstream ss;
    ss << in.rdbuf();
    return ss.str();
}

bool has_proof_output_shape(const std::string &json) {
    return contains(json, "\"proof_bundle\"") &&
           contains(json, "\"nullifier_hex\"") &&
           contains(json, "\"withdraw_instruction\"") &&
           contains(json, "\"data_hex\"") &&
           contains(json, "\"accounts\"");
}

bool has_self_test_output_shape(const std::string &json) {
    return contains(json, "\"self_test_only\"") &&
           contains(json, "\"backend\"") &&
           contains(json, "\"proof_submitted\"") &&
           (contains(json, "\"proof_submitted\":false") ||
            contains(json, "\"proof_submitted\": false"));
}

void *load_backend() {
    const char *candidates[] = {
        "libghola_shielded_pool_backend.so",
        "libshielded_pool_prover_backend.so",
        "librapidsnark_android.so",
    };
    for (const char *name : candidates) {
        void *handle = dlopen(name, RTLD_NOW | RTLD_LOCAL);
        if (handle) {
            SP_LOGI("loaded shielded-pool backend %s", name);
            return handle;
        }
    }
    return nullptr;
}

} // namespace

extern "C" {

static jstring run_backend(
    JNIEnv *env,
    const std::string &witness,
    const std::string &artifacts,
    bool self_test
) {
    if (witness.empty()) {
        throw_illegal_state(env, "Solana shielded proof witness is empty; no public fallback.");
        return nullptr;
    }
    if (!has_transfer_witness_shape(witness)) {
        throw_illegal_state(env, "Solana shielded proof witness is not a TransferWitness; no public fallback.");
        return nullptr;
    }
    if (artifacts.empty()) {
        throw_illegal_state(env, "Solana shielded proof artifact directory is empty; no public fallback.");
        return nullptr;
    }
    const std::string wasm = artifacts + "/transaction.wasm";
    const std::string zkey = artifacts + "/transaction_final.zkey";
    if (!file_exists(wasm)) {
        throw_illegal_state(env, "Solana shielded transaction.wasm is missing on device; no public fallback.");
        return nullptr;
    }
    if (!file_exists(zkey)) {
        throw_illegal_state(env, "Solana shielded transaction_final.zkey is missing on device; no public fallback.");
        return nullptr;
    }

    void *backend = load_backend();
    if (!backend) {
        const char *error = dlerror();
        SP_LOGW("no shielded-pool backend shared library found: %s", error ? error : "unknown dlopen error");
        throw_illegal_state(
            env,
            "Solana shielded native proof backend library is not packaged; no public fallback."
        );
        return nullptr;
    }

    auto prove_to_file = reinterpret_cast<ghola_shielded_pool_prove_to_file_fn>(
        dlsym(backend, "ghola_shielded_pool_prove_to_file")
    );
    if (!prove_to_file) {
        dlclose(backend);
        throw_illegal_state(
            env,
            "Solana shielded native proof backend is missing ghola_shielded_pool_prove_to_file; no public fallback."
        );
        return nullptr;
    }

    const std::string output_path = artifacts + (self_test ? "/proof-self-test-output.json" : "/proof-output.json");
    std::remove(output_path.c_str());
    char error_buf[2048];
    std::memset(error_buf, 0, sizeof(error_buf));
    int rc = prove_to_file(
        witness.c_str(),
        artifacts.c_str(),
        output_path.c_str(),
        error_buf,
        sizeof(error_buf)
    );
    dlclose(backend);
    if (rc != 0) {
        std::string message = self_test
            ? "Solana shielded native proof backend self-test failed"
            : "Solana shielded native proof backend failed";
        if (error_buf[0] != '\0') {
            message += ": ";
            message += error_buf;
        }
        message += "; no public fallback.";
        throw_illegal_state(env, message.c_str());
        return nullptr;
    }
    if (!file_exists(output_path)) {
        throw_illegal_state(env, "Solana shielded native proof backend produced no output; no public fallback.");
        return nullptr;
    }
    const std::string proof_output = read_file(output_path);
    std::remove(output_path.c_str());
    if (proof_output.empty()) {
        throw_illegal_state(env, "Solana shielded native proof backend output is empty; no public fallback.");
        return nullptr;
    }
    if (self_test) {
        if (!has_self_test_output_shape(proof_output)) {
            throw_illegal_state(env, "Solana shielded native proof backend self-test output is malformed; no public fallback.");
            return nullptr;
        }
    } else if (!has_proof_output_shape(proof_output)) {
        throw_illegal_state(env, "Solana shielded native proof backend output is malformed; no public fallback.");
        return nullptr;
    }
    return env->NewStringUTF(proof_output.c_str());
}

JNIEXPORT jstring JNICALL
Java_xyz_ghola_app_solana_ShieldedPoolNativeProver_proveNative(
    JNIEnv *env,
    jclass /* clazz */,
    jstring witnessJson,
    jstring artifactDir
) {
    const std::string witness = jstring_to_string(env, witnessJson);
    const std::string artifacts = jstring_to_string(env, artifactDir);
    return run_backend(env, witness, artifacts, false);
}

JNIEXPORT jstring JNICALL
Java_xyz_ghola_app_solana_ShieldedPoolNativeProver_selfTestNative(
    JNIEnv *env,
    jclass /* clazz */,
    jstring witnessJson,
    jstring artifactDir
) {
    const std::string witness = jstring_to_string(env, witnessJson);
    const std::string artifacts = jstring_to_string(env, artifactDir);
    return run_backend(env, witness, artifacts, true);
}

} // extern "C"
