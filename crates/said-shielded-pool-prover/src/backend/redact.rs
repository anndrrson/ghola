//! Shared stderr redaction for prover subprocess backends.
//!
//! Snarkjs (and rapidsnark's snarkjs-delegated witness-calc step) is known
//! to echo the offending `input.json` field when its circuit-input
//! validator fails. For our circuit that file contains the **spending key
//! in the clear**, so any raw child-process stderr that reaches an `Error`
//! value, a log line, or an HTTP body is a key-material leak.
//!
//! [`redact_stderr`] neutralizes every serialization form the witness can
//! take before the buffer leaves the backend:
//!
//! 1. Truncate the buffer to 1024 chars (more than enough for the snarkjs
//!    error preamble, none of the multi-kilobyte echo).
//! 2. Replace any run of ≥16 consecutive hex digits with `<hex-redacted N>`.
//! 3. Replace any run of ≥32 consecutive decimal digits with
//!    `<dec-redacted N>` (matches the decimal field-element form produced
//!    by `build_input_json`).
//! 4. Replace any bracketed / comma-separated run of ≥8 small (1–3 digit)
//!    integers with `<bytes-redacted N>`. This catches the JSON byte-array
//!    form `[119,119,...]` produced by `serde_json::to_value(&witness)` for
//!    `spending_key: [u8; 32]`, where the individual numbers are too short
//!    to trip the hex/decimal rules.
//!
//! Conservative by design: false positives are diagnostic noise, false
//! negatives are key-material leaks.
//!
//! Both [`super::snarkjs`] and [`super::rapidsnark`] route stderr through
//! this helper at the point of capture, so no raw stderr can ever enter an
//! `Error`.

/// Redact a prover child-process stderr buffer before it flows into a
/// user-visible / log-visible error message.
pub(crate) fn redact_stderr(s: &str) -> String {
    // Cap length first — anything past 1024 chars is almost certainly an
    // echoed input.json dump, not useful diagnostic text. Slice on a char
    // boundary so multi-byte UTF-8 stderr can't panic the redactor.
    let truncated: String = if s.len() > 1024 {
        let mut end = 1024;
        while end > 0 && !s.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}…[truncated {} chars]", &s[..end], s.len() - end)
    } else {
        s.to_string()
    };

    // Pass 1: hex runs (≥16). Pass 2: decimal runs (≥32). Pass 3: JSON
    // byte-array runs (≥8 comma-separated small ints). Order matters only
    // for cosmetics; the byte-array pass is independent of the digit passes
    // because its small numbers never reach the hex/decimal thresholds.
    let hex_redacted = redact_runs(&truncated, 16, |c: char| c.is_ascii_hexdigit(), "hex");
    let dec_redacted = redact_runs(&hex_redacted, 32, |c: char| c.is_ascii_digit(), "dec");
    redact_byte_arrays(&dec_redacted)
}

fn redact_runs(s: &str, min_len: usize, pred: impl Fn(char) -> bool, label: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut current_run = String::new();
    for ch in s.chars() {
        if pred(ch) {
            current_run.push(ch);
        } else {
            if current_run.len() >= min_len {
                out.push_str(&format!("<{}-redacted {} chars>", label, current_run.len()));
            } else {
                out.push_str(&current_run);
            }
            current_run.clear();
            out.push(ch);
        }
    }
    if current_run.len() >= min_len {
        out.push_str(&format!("<{}-redacted {} chars>", label, current_run.len()));
    } else {
        out.push_str(&current_run);
    }
    out
}

/// Minimum number of consecutive small integers that constitutes a
/// byte-array leak. A field element is 32 bytes; even a partial echo of a
/// few elements is sensitive, so we trip well below 32.
const MIN_BYTE_RUN: usize = 8;

/// Replace any run of ≥[`MIN_BYTE_RUN`] comma-separated 1–3 digit integers
/// with `<bytes-redacted N>`. This neutralizes the JSON array form a
/// `[u8; 32]` (the spending key) serializes to — e.g. `[119,119,...,119]` —
/// which the hex/decimal passes miss because each number is too short.
///
/// We scan token-by-token: an "integer token" is a maximal run of ascii
/// digits of length 1–3 whose value is ≤ 255 (a byte). Tokens are
/// considered part of the same run when separated only by a comma and
/// optional ascii whitespace (with optional surrounding `[` / `]`). Any
/// other character breaks the run. When a completed run has ≥ MIN_BYTE_RUN
/// tokens it is replaced; otherwise the original text is emitted verbatim.
fn redact_byte_arrays(s: &str) -> String {
    let bytes = s.as_bytes();
    let n = bytes.len();
    let mut out = String::with_capacity(n);
    let mut i = 0;

    while i < n {
        // Try to start a byte-array run at position i.
        if bytes[i].is_ascii_digit() {
            // `run_count` integer tokens parsed so far; `end` is the index
            // just past the last accepted token (and any trailing
            // comma/whitespace is NOT included so non-runs round-trip).
            let mut j = i;
            let mut run_count = 0usize;
            let mut last_token_end = i;
            loop {
                // Parse one integer token at j.
                let tok_start = j;
                let mut k = j;
                while k < n && bytes[k].is_ascii_digit() {
                    k += 1;
                }
                let tok_len = k - tok_start;
                if tok_len == 0 || tok_len > 3 {
                    break;
                }
                // Must be a byte value (≤255) to look like field-element bytes.
                let val: u32 = s[tok_start..k].parse().unwrap_or(u32::MAX);
                if val > 255 {
                    break;
                }
                run_count += 1;
                last_token_end = k;

                // Consume an optional separator: whitespace*, then a comma,
                // then whitespace*. If there's no comma, the run ends here.
                let mut sep = k;
                while sep < n && (bytes[sep] == b' ' || bytes[sep] == b'\t') {
                    sep += 1;
                }
                if sep < n && bytes[sep] == b',' {
                    sep += 1;
                    while sep < n && (bytes[sep] == b' ' || bytes[sep] == b'\t') {
                        sep += 1;
                    }
                    // Next token must be a digit to continue the run.
                    if sep < n && bytes[sep].is_ascii_digit() {
                        j = sep;
                        continue;
                    }
                }
                break;
            }

            if run_count >= MIN_BYTE_RUN {
                out.push_str(&format!("<bytes-redacted {run_count} ints>"));
                i = last_token_end;
                continue;
            }
            // Not a run. Emit (and skip past) the entire contiguous leading
            // digit run starting at `i`, then continue scanning after it.
            // We advance by the full digit run — NOT `last_token_end`, which
            // can still equal `i` when the very first token was rejected for
            // being >3 digits or >255 (e.g. "8080"). Advancing by ≥1 here is
            // what guarantees the outer loop terminates.
            let mut d = i;
            while d < n && bytes[d].is_ascii_digit() {
                d += 1;
            }
            out.push_str(&s[i..d]);
            i = d;
            continue;
        }
        // Non-digit byte: emit one UTF-8 char and advance by its byte len.
        let ch = s[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrubs_long_hex_runs() {
        let input = "Error: invalid input at line 12:\n  \"spending_key\": \"deadbeef0123456789abcdef0123456789abcdef0123456789abcdef01234567\"\n";
        let out = redact_stderr(input);
        assert!(
            !out.contains("deadbeef0123456789abcdef0123456789abcdef0123456789abcdef01234567"),
            "hex run leaked: {out}"
        );
        assert!(out.contains("<hex-redacted"));
    }

    #[test]
    fn scrubs_long_decimal_runs() {
        let input =
            "Mismatch at signal spending_key: 12345678901234567890123456789012345678901234567890";
        let out = redact_stderr(input);
        assert!(
            !out.contains("12345678901234567890123456789012345678901234567890"),
            "decimal run leaked: {out}"
        );
    }

    #[test]
    fn truncates_overlong_lines() {
        let s = "x".repeat(4096);
        let out = redact_stderr(&s);
        assert!(out.len() <= 1100, "len={}", out.len());
    }

    #[test]
    fn preserves_short_diagnostic_text() {
        let s = "snarkjs: cannot read circuit_final.zkey";
        let out = redact_stderr(s);
        assert_eq!(out, s);
    }

    #[test]
    fn scrubs_json_byte_array_spending_key() {
        // The exact form `serde_json::to_value(&witness)` produces for
        // `spending_key: [u8; 32]` filled with 0x77 (119) — the value used
        // by the types-crate test fixture.
        let arr = std::iter::repeat("119")
            .take(32)
            .collect::<Vec<_>>()
            .join(",");
        let input = format!(
            "Error in template Main_42 line 88: bad witness input \"spending_key\": [{arr}]\n"
        );
        let out = redact_stderr(&input);
        assert!(
            !out.contains("119,119"),
            "byte-array spending key leaked: {out}"
        );
        assert!(
            out.contains("<bytes-redacted"),
            "expected redaction marker: {out}"
        );
        // The single number 119 is fine to leave elsewhere; ensure we only
        // collapsed the long run.
        assert!(out.contains("Main_42"));
    }

    #[test]
    fn scrubs_bare_byte_array_without_brackets() {
        // Even without enclosing brackets, a comma-separated run must go.
        let arr = std::iter::repeat("7")
            .take(16)
            .collect::<Vec<_>>()
            .join(", ");
        let input = format!("witness: {arr} end");
        let out = redact_stderr(&input);
        assert!(!out.contains("7, 7, 7"), "leaked: {out}");
        assert!(out.contains("<bytes-redacted"));
        assert!(out.contains("witness:") && out.contains("end"));
    }

    #[test]
    fn preserves_short_integer_lists() {
        // A handful of small ints (e.g. an array length, a coordinate) is
        // below the threshold and must round-trip verbatim.
        let s = "expected 8 public signals, got 7 at index 2, 3";
        let out = redact_stderr(s);
        assert_eq!(out, s);
    }

    #[test]
    fn does_not_redact_numbers_above_255_as_bytes() {
        // Values > 255 can't be field-element bytes; a CSV of larger ints
        // breaks the run, so this should not be byte-redacted.
        let s = "ports: 8080, 9090, 3000, 4000, 5000, 6000, 7000, 1234";
        let out = redact_stderr(s);
        assert!(!out.contains("<bytes-redacted"), "false positive: {out}");
    }
}
