#include "shielded_pool_backend.h"

#include <algorithm>
#include <android/log.h>
#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <sstream>
#include <string>
#include <unistd.h>
#include <vector>

#define SPB_TAG "ShieldedPoolBackend"
#define SPB_LOGW(...) __android_log_print(ANDROID_LOG_WARN, SPB_TAG, __VA_ARGS__)

namespace {

bool file_exists(const std::string &path) {
    FILE *f = std::fopen(path.c_str(), "rb");
    if (!f) return false;
    std::fclose(f);
    return true;
}

bool write_file(const std::string &path, const char *data) {
    std::ofstream out(path, std::ios::binary | std::ios::trunc);
    if (!out) return false;
    out << data;
    return out.good();
}

// H2: overwrite the file contents with zeros before unlinking so the witness
// plaintext (spending key) is not trivially recoverable from the freed flash
// blocks. Best-effort — flash wear-levelling means this is not a guaranteed
// secure erase, but it removes the obvious recovery path. A real prover should
// avoid writing the witness to a file at all (see shielded_pool_backend.h).
void remove_file(const std::string &path) {
    {
        std::ifstream probe(path, std::ios::binary | std::ios::ate);
        if (probe) {
            const std::streamoff size = probe.tellg();
            probe.close();
            if (size > 0) {
                std::ofstream wipe(path, std::ios::binary | std::ios::in | std::ios::out);
                if (wipe) {
                    std::vector<char> zeros(4096, 0);
                    std::streamoff written = 0;
                    while (written < size) {
                        const std::streamoff chunk =
                            std::min<std::streamoff>(zeros.size(), size - written);
                        wipe.write(zeros.data(), static_cast<std::streamsize>(chunk));
                        written += chunk;
                    }
                    wipe.flush();
                }
            }
        }
    }
    std::remove(path.c_str());
}

void remove_dir(const std::string &path) {
    rmdir(path.c_str());
}

void write_error(char *error_buf, size_t error_buf_len, const char *message) {
    if (!error_buf || error_buf_len == 0) return;
    std::snprintf(error_buf, error_buf_len, "%s", message);
}

bool contains(const char *haystack, const char *needle) {
    return haystack && std::strstr(haystack, needle) != nullptr;
}

bool json_bool_true(const char *json, const char *field) {
    const std::string compact = std::string("\"") + field + "\":true";
    const std::string spaced = std::string("\"") + field + "\": true";
    return contains(json, compact.c_str()) || contains(json, spaced.c_str());
}

bool write_text(const std::string &path, const char *text) {
    std::ofstream out(path, std::ios::binary | std::ios::trunc);
    if (!out) return false;
    out << text;
    return out.good();
}

class ProofWorkdir {
public:
    explicit ProofWorkdir(const std::string &artifact_dir) {
        std::string templ = artifact_dir + "/proof-work-XXXXXX";
        std::vector<char> buf(templ.begin(), templ.end());
        buf.push_back('\0');
        char *created = mkdtemp(buf.data());
        if (created) path_ = created;
    }

    ~ProofWorkdir() {
        if (!path_.empty()) remove_dir(path_);
    }

    bool ok() const { return !path_.empty(); }
    std::string path(const char *name) const { return path_ + "/" + name; }

private:
    std::string path_;
};

int prove_groth16_mobile(
    const std::string & /* transaction_wasm */,
    const std::string & /* transaction_zkey */,
    const std::string & /* input_json */,
    const std::string & /* witness_wtns */,
    const std::string & /* proof_json */,
    const std::string & /* public_json */,
    char *error_buf,
    size_t error_buf_len
) {
    write_error(
        error_buf,
        error_buf_len,
        "mobile Groth16 prover backend is not implemented in this build"
    );
    return 1;
}

} // namespace

extern "C" int ghola_shielded_pool_prove_to_file(
    const char *transfer_witness_json,
    const char *artifact_dir,
    const char *output_json_path,
    char *error_buf,
    size_t error_buf_len
) {
    if (!transfer_witness_json || transfer_witness_json[0] == '\0') {
        write_error(error_buf, error_buf_len, "transfer witness is empty");
        return 2;
    }
    if (!artifact_dir || artifact_dir[0] == '\0') {
        write_error(error_buf, error_buf_len, "artifact directory is empty");
        return 3;
    }
    if (!contains(transfer_witness_json, "\"spending_key\"") ||
        !contains(transfer_witness_json, "\"input_notes\"") ||
        !contains(transfer_witness_json, "\"input_paths\"")) {
        write_error(error_buf, error_buf_len, "transfer witness is missing required secret inputs");
        return 4;
    }

    const std::string base(artifact_dir);
    const std::string transaction_wasm = base + "/transaction.wasm";
    const std::string transaction_zkey = base + "/transaction_final.zkey";
    if (!file_exists(transaction_wasm)) {
        write_error(error_buf, error_buf_len, "transaction.wasm is missing");
        return 5;
    }
    if (!file_exists(transaction_zkey)) {
        write_error(error_buf, error_buf_len, "transaction_final.zkey is missing");
        return 6;
    }

    ProofWorkdir workdir(base);
    if (!workdir.ok()) {
        write_error(error_buf, error_buf_len, "failed to create private proof workdir");
        return 7;
    }

    const std::string input_json = workdir.path("input.json");
    const std::string witness_wtns = workdir.path("witness.wtns");
    const std::string proof_json = workdir.path("proof.json");
    const std::string public_json = workdir.path("public.json");

    if (!write_file(input_json, transfer_witness_json)) {
        write_error(error_buf, error_buf_len, "failed to write local witness input");
        return 8;
    }

    if (json_bool_true(transfer_witness_json, "self_test_only")) {
        if (!output_json_path || output_json_path[0] == '\0') {
            write_error(error_buf, error_buf_len, "self-test output path is empty");
            return 10;
        }
        const char *self_test_json =
            "{"
            "\"self_test_only\":true,"
            "\"backend\":\"ghola_shielded_pool_backend_stub\","
            "\"witness_input_written\":true,"
            "\"artifacts_present\":true,"
            "\"groth16_call_site\":\"prove_groth16_mobile\","
            "\"proof_submitted\":false"
            "}";
        if (!write_text(output_json_path, self_test_json)) {
            write_error(error_buf, error_buf_len, "failed to write self-test output");
            return 11;
        }
        remove_file(input_json);
        return 0;
    }

    SPB_LOGW("backend scaffold reached Groth16 call site; mobile prover is not linked");
    int rc = prove_groth16_mobile(
        transaction_wasm,
        transaction_zkey,
        input_json,
        witness_wtns,
        proof_json,
        public_json,
        error_buf,
        error_buf_len
    );
    remove_file(input_json);
    remove_file(witness_wtns);
    remove_file(proof_json);
    remove_file(public_json);
    if (rc != 0) return rc;

    write_error(error_buf, error_buf_len, "backend scaffold returned success without proof output");
    return 9;
}
