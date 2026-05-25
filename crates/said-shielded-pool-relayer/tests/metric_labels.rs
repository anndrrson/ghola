//! Stream 7 (production-hardening) — Prometheus label allowlist.
//!
//! Snapshots the relayer's metric exposition and asserts that every
//! emitted line either is a `# HELP` / `# TYPE` directive OR has a
//! metric NAME drawn from the allowlist below. Any non-allowlisted
//! label key (or a high-cardinality value like a queue id, recipient,
//! or amount) would fail this test.
//!
//! Cross-reference: `docs/shielded-pool/OPERATIONS.md` § 2.6 (Metrics).

use said_shielded_pool_relayer::metrics::Metrics;

/// Metric names the relayer is allowed to expose. NO label keys are
/// permitted (the relayer uses no Prometheus labels at all — every
/// metric is a pre-bucketed gauge or counter).
const METRIC_ALLOWLIST: &[&str] = &[
    "relayer_queue_depth",
    "relayer_anonymity_set_size_last",
    "relayer_submit_latency_ms_p50",
    "relayer_submit_latency_ms_p99",
    "relayer_submit_success_total",
    "relayer_submit_failure_total",
    "relayer_submit_success_rate",
    "relayer_decoy_tx_count_total",
];

/// Plan-mandated label allowlist (the abstract names the plan
/// references). The current implementation maps each to a concrete
/// metric name via the prefix `relayer_*`.
const ABSTRACT_LABEL_KEYS: &[&str] =
    &["queue_depth", "anonymity_set_size", "latency_bucket", "decoy_count"];

#[test]
fn rendered_metrics_only_use_allowlisted_names() {
    // Drive a few state transitions so the rendered output is non-trivial.
    let m = Metrics::new();
    m.set_queue_depth(3);
    m.observe_anonymity_set(7);
    m.observe_submit_latency(std::time::Duration::from_millis(42));
    m.record_submit_success();
    m.record_submit_failure();
    m.record_decoy();

    let rendered = m.render();
    for line in rendered.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // Each non-comment line is `metric_name <value>` with NO labels.
        // If a `{` ever appears the metric grew a label and the privacy
        // contract is violated — fail loudly so the audit catches it.
        assert!(
            !line.contains('{'),
            "metric line {line:?} contains a label; relayer metrics MUST be label-free"
        );
        let name = line.split_whitespace().next().unwrap_or("");
        assert!(
            METRIC_ALLOWLIST.contains(&name),
            "metric {name:?} not on allowlist; update METRIC_ALLOWLIST or revert the new metric"
        );
    }
}

#[test]
fn abstract_label_keys_documented() {
    // The plan's abstract allowlist is {queue_depth, anonymity_set_size,
    // latency_bucket, decoy_count}. Each abstract key maps to a
    // concrete metric in this implementation; the mapping below is the
    // documented bridge so a future renaming pass can adjust either
    // side. `latency_bucket` maps to BOTH p50 and p99 quantile gauges
    // — quantiles are a structurally-bucketed family.
    let mapping: &[(&str, &[&str])] = &[
        ("queue_depth", &["relayer_queue_depth"]),
        (
            "anonymity_set_size",
            &["relayer_anonymity_set_size_last"],
        ),
        (
            "latency_bucket",
            &[
                "relayer_submit_latency_ms_p50",
                "relayer_submit_latency_ms_p99",
            ],
        ),
        ("decoy_count", &["relayer_decoy_tx_count_total"]),
    ];
    // Sanity: every abstract key listed in the plan appears here.
    for ak in ABSTRACT_LABEL_KEYS {
        assert!(
            mapping.iter().any(|(k, _)| k == ak),
            "abstract key {ak:?} missing from mapping"
        );
    }
    // And every concrete name resolves into the allowlist.
    for (_, concretes) in mapping {
        for c in *concretes {
            assert!(
                METRIC_ALLOWLIST.contains(c),
                "concrete metric {c:?} not on METRIC_ALLOWLIST"
            );
        }
    }
}

#[test]
fn no_per_recipient_or_amount_fields_in_output() {
    let m = Metrics::new();
    m.set_queue_depth(1);
    m.observe_anonymity_set(3);
    let r = m.render();
    // Hard ban on the deny-listed field names in metric output.
    for forbidden in [
        "recipient",
        "amount",
        "commitment",
        "nullifier",
        "proof",
        "spending_key",
        "viewing_key",
        "signature",
        "signing_key",
    ] {
        assert!(
            !r.contains(forbidden),
            "metrics output contains forbidden token {forbidden:?}: {r}"
        );
    }
}
