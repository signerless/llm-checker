const {
    normalizeRuntime,
    runtimeSupportsSpeculativeDecoding,
    runtimeSupportedOnHardware,
    getRuntimeModelRef
} = require('../runtime/runtime-support');

class SpeculativeDecodingEstimator {
    constructor(options = {}) {
        this.minDraftRatio = options.minDraftRatio || 0.1;
        this.maxDraftRatio = options.maxDraftRatio || 0.65;
        this.idealDraftRatio = options.idealDraftRatio || 0.28;

        this.knownFamilies = [
            'llama',
            'qwen',
            'mistral',
            'mixtral',
            'gemma',
            'phi',
            'deepseek',
            'yi',
            'command-r'
        ];
    }

    estimate({ model, candidates = [], hardware = {}, runtime = 'ollama' } = {}) {
        const selectedRuntime = normalizeRuntime(runtime);

        if (!runtimeSupportsSpeculativeDecoding(selectedRuntime)) {
            return null;
        }

        const targetParams = this.extractParams(model);
        if (!targetParams || targetParams < 2) {
            return {
                runtime: selectedRuntime,
                supported: true,
                enabled: false,
                reason: 'Target model is too small for meaningful speculative decoding gains.'
            };
        }

        const family = this.extractFamily(model);
        const draftCandidate = this.selectDraftCandidate(model, candidates, family, targetParams);

        if (!draftCandidate) {
            const suggestedDraftParams = this.getSuggestedDraftParams(targetParams);
            const estimatedSpeedup = this.estimateSpeedup({
                targetParams,
                draftParams: suggestedDraftParams,
                runtime: selectedRuntime,
                hardware,
                model
            });

            return {
                runtime: selectedRuntime,
                supported: true,
                enabled: false,
                estimatedSpeedup: Number(estimatedSpeedup.toFixed(2)),
                estimatedThroughputGainPct: Math.round((estimatedSpeedup - 1) * 100),
                suggestedDraftModel: family ? `${family} ~${suggestedDraftParams}B` : `~${suggestedDraftParams}B draft`,
                reason: 'No compatible draft model found in the current shortlist.'
            };
        }

        const draftParams = draftCandidate.params;
        const estimatedSpeedup = this.estimateSpeedup({
            targetParams,
            draftParams,
            runtime: selectedRuntime,
            hardware,
            model
        });

        const confidence = this.estimateConfidence({
            family,
            targetParams,
            draftParams,
            runtime: selectedRuntime,
            hardware
        });

        return {
            runtime: selectedRuntime,
            supported: true,
            enabled: true,
            targetModelRef: getRuntimeModelRef(model, selectedRuntime),
            draftModel: draftCandidate.model.name || draftCandidate.model.model_identifier || 'draft-model',
            draftModelRef: getRuntimeModelRef(draftCandidate.model, selectedRuntime),
            targetParams,
            draftParams,
            draftToTargetRatio: Number((draftParams / targetParams).toFixed(2)),
            estimatedSpeedup: Number(estimatedSpeedup.toFixed(2)),
            estimatedThroughputGainPct: Math.round((estimatedSpeedup - 1) * 100),
            confidence: Number(confidence.toFixed(2)),
            notes: this.buildNotes(selectedRuntime, family, estimatedSpeedup)
        };
    }

    extractParams(model = {}) {
        const direct = Number(model.params_b || model.paramsB);
        if (Number.isFinite(direct) && direct > 0) {
            return direct;
        }

        const sources = [
            model.size,
            model.name,
            model.model_identifier,
            model.ollamaTag,
            model.ollamaId
        ].filter(Boolean);

        for (const source of sources) {
            const text = String(source).toLowerCase();
            const match = text.match(/(\d+(\.\d+)?)\s*b\b/i);
            if (match) {
                const params = Number(match[1]);
                if (Number.isFinite(params) && params > 0) {
                    return params;
                }
            }
        }

        return null;
    }

    extractFamily(model = {}) {
        const text = String(
            model.model_identifier ||
            model.ollamaId ||
            model.ollamaTag ||
            model.name ||
            ''
        ).toLowerCase();

        for (const family of this.knownFamilies) {
            if (text.includes(family)) {
                return family;
            }
        }

        return '';
    }

    selectDraftCandidate(model, candidates, targetFamily, targetParams) {
        const normalizedTargetName = String(model?.name || model?.model_identifier || '').toLowerCase();

        const draftCandidates = candidates
            .map((candidate) => {
                const params = this.extractParams(candidate);
                const family = this.extractFamily(candidate);
                const ratio = params && targetParams ? params / targetParams : null;

                return { model: candidate, params, family, ratio };
            })
            .filter((candidate) => {
                const candidateName = String(candidate.model?.name || candidate.model?.model_identifier || '').toLowerCase();
                if (!candidate.params || candidate.params >= targetParams) return false;
                if (!candidate.ratio || candidate.ratio < this.minDraftRatio || candidate.ratio > this.maxDraftRatio) return false;
                if (candidateName === normalizedTargetName) return false;

                // Prefer same-family models due to tokenizer/embedding compatibility.
                if (targetFamily && candidate.family) {
                    return targetFamily === candidate.family;
                }

                return true;
            })
            .sort((a, b) => {
                // Prefer ratio close to ideal draft ratio.
                const scoreA = Math.abs((a.ratio || 0) - this.idealDraftRatio);
                const scoreB = Math.abs((b.ratio || 0) - this.idealDraftRatio);
                return scoreA - scoreB;
            });

        return draftCandidates[0] || null;
    }

    estimateSpeedup({ targetParams, draftParams, runtime, hardware, model }) {
        const ratio = Math.max(1.01, targetParams / Math.max(0.1, draftParams));

        // Base heuristic: diminishing returns as ratio grows.
        let speedup = 1.05 + Math.log2(ratio) * 0.45;

        if (ratio > 6) {
            speedup -= 0.12;
        }

        if (runtime === 'vllm') {
            speedup += 0.12;
        } else if (runtime === 'mlx') {
            speedup += 0.08;
        }

        if (runtime === 'mlx' && runtimeSupportedOnHardware('mlx', hardware)) {
            speedup += 0.08;
        }

        if (model?.is_moe || model?.isMoE) {
            speedup *= 0.92;
        }

        return Math.max(1.1, Math.min(2.8, speedup));
    }

    estimateConfidence({ family, targetParams, draftParams, runtime, hardware }) {
        let confidence = 0.55;
        const ratio = draftParams / targetParams;

        if (family) confidence += 0.15;
        if (ratio >= 0.2 && ratio <= 0.4) confidence += 0.15;
        if (runtime === 'vllm') confidence += 0.05;
        if (runtime === 'mlx') confidence += 0.03;

        if (runtime === 'mlx' && runtimeSupportedOnHardware('mlx', hardware)) {
            confidence += 0.05;
        }

        return Math.min(0.95, confidence);
    }

    getSuggestedDraftParams(targetParams) {
        const draft = Math.max(1, targetParams * this.idealDraftRatio);
        return Number(draft.toFixed(1));
    }

    buildNotes(runtime, family, speedup) {
        const notes = [];
        if (family) {
            notes.push(`Same-family draft model (${family}) improves tokenizer/embedding alignment.`);
        }
        if (runtime === 'vllm') {
            notes.push('Use --speculative-model in vLLM to enable speculative decoding.');
        } else if (runtime === 'mlx') {
            notes.push('MLX-LM speculative decoding works best with unified memory on Apple Silicon.');
        }
        notes.push(`Estimated throughput multiplier: x${speedup.toFixed(2)}.`);
        return notes;
    }
}

module.exports = SpeculativeDecodingEstimator;
