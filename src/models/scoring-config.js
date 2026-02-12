/**
 * Centralized Scoring Weight Configuration
 *
 * Three scoring systems exist with different weights because they serve
 * different purposes:
 *
 * DETERMINISTIC_WEIGHTS - Used by the primary recommendation engine
 *   (deterministic-selector.js). Weights are per-category arrays [Q, S, F, C]
 *   where Q=quality, S=speed, F=fit, C=context.
 *
 * MULTI_OBJECTIVE_WEIGHTS - Used by multi-objective-selector.js for
 *   hardware-aware selection. Uses 5 factors: quality, speed, ttfb, context,
 *   hardwareMatch. Emphasizes hardware fit more heavily.
 *
 * SCORING_ENGINE_WEIGHTS - Used by scoring-engine.js (powers smart-recommend
 *   and search commands). Uses {Q, S, F, C} objects with additional presets
 *   for specialized use cases like "fast" and "quality" modes.
 */

// deterministic-selector.js category weights [Q, S, F, C]
const DETERMINISTIC_WEIGHTS = {
    general:       [0.45, 0.35, 0.15, 0.05],
    coding:        [0.55, 0.20, 0.15, 0.10],
    reasoning:     [0.60, 0.10, 0.20, 0.10],
    multimodal:    [0.50, 0.15, 0.20, 0.15],
    summarization: [0.40, 0.35, 0.15, 0.10],
    reading:       [0.40, 0.35, 0.15, 0.10],
    embeddings:    [0.30, 0.50, 0.20, 0.00]
};

// multi-objective-selector.js category weights {quality, speed, ttfb, context, hardwareMatch}
const MULTI_OBJECTIVE_WEIGHTS = {
    general:    { quality: 0.45, speed: 0.15, ttfb: 0.05, context: 0.05, hardwareMatch: 0.30 },
    coding:     { quality: 0.45, speed: 0.15, ttfb: 0.05, context: 0.10, hardwareMatch: 0.25 },
    reasoning:  { quality: 0.50, speed: 0.10, ttfb: 0.05, context: 0.15, hardwareMatch: 0.20 },
    multimodal: { quality: 0.40, speed: 0.10, ttfb: 0.05, context: 0.10, hardwareMatch: 0.35 },
    longctx:    { quality: 0.30, speed: 0.10, ttfb: 0.05, context: 0.35, hardwareMatch: 0.20 }
};

// scoring-engine.js weight presets {Q, S, F, C}
const SCORING_ENGINE_WEIGHTS = {
    general:    { Q: 0.40, S: 0.35, F: 0.15, C: 0.10 },
    coding:     { Q: 0.55, S: 0.20, F: 0.15, C: 0.10 },
    reasoning:  { Q: 0.60, S: 0.15, F: 0.10, C: 0.15 },
    chat:       { Q: 0.40, S: 0.40, F: 0.15, C: 0.05 },
    creative:   { Q: 0.50, S: 0.25, F: 0.15, C: 0.10 },
    embeddings: { Q: 0.30, S: 0.50, F: 0.15, C: 0.05 },
    vision:     { Q: 0.50, S: 0.25, F: 0.15, C: 0.10 },
    fast:       { Q: 0.25, S: 0.55, F: 0.15, C: 0.05 },
    quality:    { Q: 0.65, S: 0.10, F: 0.15, C: 0.10 }
};

module.exports = {
    DETERMINISTIC_WEIGHTS,
    MULTI_OBJECTIVE_WEIGHTS,
    SCORING_ENGINE_WEIGHTS
};
