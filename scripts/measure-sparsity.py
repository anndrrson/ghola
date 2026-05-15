#!/usr/bin/env python3
"""Measure per-FFN-layer activation sparsity for the ghola default
local-mode model — the Phase-A input to the Apple-flash-memory
adoption plan in .claude/plans/zesty-giggling-charm.md.

Why: Apple's paper reports 90%+ post-ReLU sparsity in OPT and
FATReLU-finetuned Llama-2, which is what makes selective FFN loading
worth the engineering. Llama-3.2-1B-Instruct uses SwiGLU, whose
intermediate activations are not naturally sparse. This script
measures the real per-token sparsity of `gate_proj * up_proj` (the
SwiGLU intermediate) so the Phase-A decision gate has a real number
to gate on, not a hand-wave.

Definitions used here:
  - intermediate    = silu(gate_proj(x)) * up_proj(x)
  - "active neuron" = |intermediate[i]| >= threshold (default 1e-3)
  - "sparsity"      = fraction of intermediate units that are inactive

The Phase-A decision gate (per the plan):
  >= 50%   → Phase C/D translation likely worthwhile; ~30-40% latency win
   40-49%  → marginal; still consider Phase B + E
   < 40%   → skip Phase C; ship Phase B + E only

Usage:
  pip install transformers torch datasets
  python scripts/measure-sparsity.py \\
      --model meta-llama/Llama-3.2-1B-Instruct \\
      --prompts scripts/sparsity-prompts.txt \\
      --threshold 1e-3 \\
      --output docs/perf/sparsity-llama-3.2-1b.json

If --prompts is omitted, a built-in 50-prompt corpus is used (mix of
chat, code, math, narrative — broad coverage of the activation
landscape).

Output JSON shape (also consumed by Phase A baseline JSON merge):
{
  "model": "meta-llama/Llama-3.2-1B-Instruct",
  "threshold": 1e-3,
  "n_prompts": 50,
  "n_layers": 16,
  "intermediate_size": 8192,
  "per_layer": [
    {
      "layer": 0,
      "mean_active_fraction": 0.42,        # ← Apple's "density"
      "mean_sparsity": 0.58,
      "p10_active_fraction": 0.31,
      "p90_active_fraction": 0.51
    },
    ...
  ],
  "overall_mean_active_fraction": 0.41,
  "overall_mean_sparsity": 0.59,
  "decision": "phase_c_marginal"
}

This script does NOT require WebGPU or MLC; it just loads the HF
weights and runs forward passes through the SwiGLU MLP per layer
with a hook on the intermediate tensor.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from statistics import mean


DEFAULT_PROMPTS = [
    "Write a short poem about the ocean at dusk.",
    "Explain how a bicycle stays upright when in motion.",
    "What's the difference between TCP and UDP, briefly?",
    "Translate to French: 'The quick brown fox jumps over the lazy dog.'",
    "Refactor this Python: def add(a,b):\\n  return a+b into a typed version.",
    "Summarize the plot of Hamlet in three sentences.",
    "What is the chemical formula for caffeine and what does it do?",
    "Give me a one-paragraph elevator pitch for a privacy-first AI product.",
    "How does end-to-end encryption differ from transport encryption?",
    "Compose a haiku about debugging at 3 AM.",
    "List 5 ways to reduce cold-start latency in a serverless function.",
    "What's the time complexity of merge sort, and why?",
    "Write a friendly DM rejecting a meeting politely.",
    "Explain Bayes' theorem with a single concrete example.",
    "What's a sliding window algorithm, and when would you use one?",
    "Generate a SQL query that finds the top 5 customers by revenue this quarter.",
    "What happens when you type 'ls' in a Unix shell?",
    "Describe the Solana account model in one paragraph.",
    "What's the difference between SwiGLU and ReLU activations?",
    "Give three pros and three cons of WebGPU for in-browser ML.",
    "Write a regex that matches an ISO-8601 timestamp.",
    "Compose two sentences mimicking Hemingway's prose style.",
    "Explain HKDF as if I'm a smart college freshman.",
    "What's the largest prime less than 1000? Show your reasoning.",
    "Convert 98.6°F to Celsius. Show the formula.",
    "What is the airspeed velocity of an unladen swallow?",
    "Describe the taste of an extremely ripe mango.",
    "Write a one-line bash command to find every TODO in a repo.",
    "What's an attestation document in the AWS Nitro context?",
    "Explain mixture-of-experts in one paragraph.",
    "Critique this sentence: 'The reason why is because…'",
    "Give me a tongue-twister using 'fluffy waffle'.",
    "What's the difference between an LLM and a foundation model?",
    "Sketch a 4-bullet outline for a blog post on private inference.",
    "If a train leaves Chicago at 60mph and another leaves NYC at 80mph, when do they meet?",
    "What's the etymology of the word 'algorithm'?",
    "Write a brief one-paragraph apology for a missed deadline.",
    "Describe how WebGPU shader compilation differs from WebGL.",
    "What does 'idempotent' mean for an HTTP method?",
    "Compose a six-word memoir.",
    "Translate to Spanish: 'I would like a coffee, please.'",
    "Define 'agentic AI' in non-jargon terms.",
    "What's a Merkle tree useful for, and why?",
    "Give a one-paragraph explanation of zero-knowledge proofs.",
    "Write a unit-test docstring for a function that hashes a password.",
    "List three failure modes of speculative decoding.",
    "What's a low-rank factorization, intuitively?",
    "Compose a thank-you note to a mentor.",
    "Explain why floating-point math is not associative.",
    "What's the practical difference between FP16 and BF16?",
]


def load_prompts(path: str | None) -> list[str]:
    if path is None:
        return DEFAULT_PROMPTS
    text = Path(path).read_text(encoding="utf-8")
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    if not lines:
        raise SystemExit(f"prompt file {path!r} is empty")
    return lines


def decision_for(mean_active_fraction: float) -> str:
    if mean_active_fraction <= 0.50:
        return "phase_c_worthwhile"
    if mean_active_fraction <= 0.60:
        return "phase_c_marginal"
    return "phase_c_skip"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="meta-llama/Llama-3.2-1B-Instruct")
    ap.add_argument("--prompts", default=None,
                    help="Path to a newline-delimited prompt file. "
                         "Defaults to the built-in 50-prompt corpus.")
    ap.add_argument("--threshold", type=float, default=1e-3,
                    help="|intermediate| >= threshold counts as active.")
    ap.add_argument("--max-new-tokens", type=int, default=8,
                    help="Per-prompt generated tokens. Sparsity is measured "
                         "at the prompt-encode pass; new tokens only add a "
                         "single per-token measurement each. Keep small to "
                         "bound runtime.")
    ap.add_argument("--output", default="docs/perf/sparsity-llama-3.2-1b.json")
    args = ap.parse_args()

    try:
        import torch  # noqa: F401
        from transformers import AutoModelForCausalLM, AutoTokenizer
    except ImportError as e:
        print(f"missing dep: {e}. Install: pip install transformers torch",
              file=sys.stderr)
        return 2

    import torch

    prompts = load_prompts(args.prompts)
    print(f"loading {args.model}...", file=sys.stderr)
    tok = AutoTokenizer.from_pretrained(args.model)
    model = AutoModelForCausalLM.from_pretrained(
        args.model,
        torch_dtype=torch.float16,
        device_map="auto",
    )
    model.eval()

    # Locate the MLP layers. Llama exposes them as
    # model.model.layers[i].mlp with .gate_proj, .up_proj, .down_proj.
    layers = model.model.layers
    n_layers = len(layers)
    intermediate_size = layers[0].mlp.gate_proj.out_features

    # Per-layer running active-fraction sample list.
    per_layer_samples: list[list[float]] = [[] for _ in range(n_layers)]

    hooks = []
    # We hook AFTER gate_proj and up_proj are both available — the
    # simplest way is to monkey-patch the MLP.forward to compute the
    # intermediate ourselves. Llama's MLP is:
    #     down_proj(silu(gate_proj(x)) * up_proj(x))
    # We compute the inner product before the down_proj and measure it.
    captured: dict[int, torch.Tensor] = {}

    def make_hook(layer_idx: int):
        def hook(module, inputs, output):
            # output of mlp.up_proj has same shape as the intermediate
            # we care about. But for SwiGLU we need silu(gate)*up, so
            # we capture both via the gate-proj forward hook below.
            pass
        return hook

    # Capture gate_proj outputs.
    gate_outputs: dict[int, torch.Tensor] = {}
    def make_gate_hook(i: int):
        def h(_m, _inp, out):
            gate_outputs[i] = out.detach()
        return h

    up_outputs: dict[int, torch.Tensor] = {}
    def make_up_hook(i: int):
        def h(_m, _inp, out):
            up_outputs[i] = out.detach()
        return h

    for i, layer in enumerate(layers):
        hooks.append(layer.mlp.gate_proj.register_forward_hook(make_gate_hook(i)))
        hooks.append(layer.mlp.up_proj.register_forward_hook(make_up_hook(i)))

    silu = torch.nn.SiLU()

    try:
        for pi, prompt in enumerate(prompts):
            gate_outputs.clear()
            up_outputs.clear()
            inputs = tok(prompt, return_tensors="pt").to(model.device)
            with torch.no_grad():
                _ = model(**inputs)
            # gate_outputs[i] and up_outputs[i] are shape
            # (batch=1, seq_len, intermediate_size).
            for i in range(n_layers):
                g = gate_outputs[i]
                u = up_outputs[i]
                inter = silu(g) * u                 # SwiGLU intermediate
                # Active per token: |inter| >= threshold per neuron.
                active = (inter.abs() >= args.threshold).float()
                # Mean over (batch, seq, neurons) — equivalent to:
                # average over tokens of (per-token-active-fraction).
                af = active.mean().item()
                per_layer_samples[i].append(af)
            if (pi + 1) % 10 == 0:
                print(f"  processed {pi + 1}/{len(prompts)} prompts",
                      file=sys.stderr)
    finally:
        for h in hooks:
            h.remove()

    def pct(xs: list[float], p: float) -> float:
        if not xs:
            return 0.0
        s = sorted(xs)
        k = max(0, min(len(s) - 1, int(p * (len(s) - 1))))
        return s[k]

    per_layer: list[dict] = []
    overall_samples: list[float] = []
    for i, xs in enumerate(per_layer_samples):
        m = mean(xs) if xs else 0.0
        per_layer.append({
            "layer": i,
            "mean_active_fraction": round(m, 4),
            "mean_sparsity": round(1.0 - m, 4),
            "p10_active_fraction": round(pct(xs, 0.10), 4),
            "p90_active_fraction": round(pct(xs, 0.90), 4),
        })
        overall_samples.extend(xs)

    overall = mean(overall_samples) if overall_samples else 0.0
    result = {
        "model": args.model,
        "threshold": args.threshold,
        "n_prompts": len(prompts),
        "n_layers": n_layers,
        "intermediate_size": intermediate_size,
        "per_layer": per_layer,
        "overall_mean_active_fraction": round(overall, 4),
        "overall_mean_sparsity": round(1.0 - overall, 4),
        "decision": decision_for(overall),
    }

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))
    print(f"\nwrote {out_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
