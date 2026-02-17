# Ollama Critical Needs We Can Ship

Last updated: 2026-02-17

This guide summarizes high-impact pain points from active Ollama users and maps them to concrete `llm-checker` features we can ship quickly.

## Why this matters

Ollama adoption is high, but production users still struggle with:

- memory crashes and unstable parallelism
- context window surprises
- AMD/Windows reliability edge cases
- tool-calling compatibility across models

If `llm-checker` solves these first, we become the practical operations layer on top of Ollama.

## Evidence snapshot

Recent public issues in `ollama/ollama`:

- Parallel/OOM instability: [#13887](https://github.com/ollama/ollama/issues/13887), [#13025](https://github.com/ollama/ollama/issues/13025)
- Context behavior mismatch: [#14183](https://github.com/ollama/ollama/issues/14183)
- AMD/Windows and ROCm reliability: [#13920](https://github.com/ollama/ollama/issues/13920), [#13791](https://github.com/ollama/ollama/issues/13791)
- Tool-calling parsing/compatibility: [#12064](https://github.com/ollama/ollama/issues/12064), [#10976](https://github.com/ollama/ollama/issues/10976)
- Jetson setup friction: [#9503](https://github.com/ollama/ollama/issues/9503), [#11128](https://github.com/ollama/ollama/issues/11128)

## Priority roadmap

### P0: Ollama Capacity Planner

Problem:

- Users cannot safely choose `num_ctx`, parallelism, and loaded models for their hardware.
- This causes OOM, runner crashes, and low throughput.

What to ship:

- New command: `llm-checker ollama-plan`
- Inputs: model(s), target context, target concurrency, objective (`latency|throughput|balanced`)
- Output:
  - safe config envelope
  - recommended environment values (for example, parallel/model loading guidance)
  - risk score and fallback profile

Success metric:

- Fewer crash/oom reports from users running generated config.

### P1: Multi-GPU Placement Advisor

Problem:

- Users with multiple GPUs do not know whether to spread or pin workloads.

What to ship:

- New command: `llm-checker gpu-plan`
- Recommends placement strategy per model and objective.
- Simulates memory fit and expected throughput under each strategy.

Success metric:

- Higher token/s with fewer failed loads in multi-GPU setups.

### P1: Context Window Verifier

Problem:

- Requested context and effective context can diverge in real runs.

What to ship:

- New command: `llm-checker verify-context --model ... --ctx ...`
- Runs a deterministic check, reports effective context behavior, and suggests safe operating bounds.

Success metric:

- Fewer context-related regressions and surprises.

### P2: AMD/Windows Reliability Guard

Problem:

- AMD/Windows users frequently hit fallback and initialization issues.

What to ship:

- New command: `llm-checker amd-guard`
- Hardware/runtime diagnostics + safe config template + known workaround hints.

Success metric:

- Lower failure rate on first-run for AMD/Windows users.

### P2: Tool-Calling Compatibility Tester

Problem:

- Tool-calling behavior still varies between models and prompt styles.

What to ship:

- New command: `llm-checker toolcheck --model ...`
- Executes a small compatibility suite (json schema, arguments, streaming behavior).
- Outputs pass/fail matrix and production readiness grade.

Success metric:

- Reduced tool-call parsing failures in downstream apps.

## 2-week execution proposal

Week 1:

1. Ship `ollama-plan` MVP
2. Add baseline telemetry/report format
3. Add docs and examples

Week 2:

1. Ship `verify-context`
2. Add `amd-guard` diagnostics MVP
3. Open beta for power users with feedback loop

## Recommended first launch

Start with `ollama-plan` as the flagship feature.

Reason:

- highest user pain
- easiest to explain
- creates immediate value even for non-expert users
