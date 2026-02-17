const { z } = require('zod');

const SUPPORTED_CALIBRATION_OBJECTIVES = ['speed', 'quality', 'balanced'];
const SUPPORTED_CALIBRATION_EXECUTION_MODES = ['dry-run', 'contract-only', 'full'];
const DEFAULT_CALIBRATION_TASK = 'general';

const nonEmptyStringSchema = z.string().trim().min(1);
const nonNegativeNumberSchema = z.number().finite().min(0);
const percentageScoreSchema = z.number().finite().min(0).max(100);
const nonNegativeIntegerSchema = z.number().int().min(0);

const isoDateTimeSchema = nonEmptyStringSchema.refine(
    (value) => !Number.isNaN(Date.parse(value)),
    'Must be a valid ISO timestamp'
);

const calibrationObjectiveSchema = z.enum(SUPPORTED_CALIBRATION_OBJECTIVES);
const calibrationExecutionModeSchema = z.enum(SUPPORTED_CALIBRATION_EXECUTION_MODES);
const runtimeSchema = z.enum(['ollama', 'vllm', 'mlx']);

const promptSuiteCheckSchema = z
    .object({
        type: z.enum(['exact', 'contains', 'regex']),
        expected: nonEmptyStringSchema,
        weight: z.number().finite().positive().optional()
    })
    .strict();

const promptSuiteEntrySchema = z
    .object({
        id: nonEmptyStringSchema.optional(),
        task: nonEmptyStringSchema.optional(),
        prompt: nonEmptyStringSchema,
        checks: z.array(promptSuiteCheckSchema).optional()
    })
    .strict();

const calibrationMetricsSchema = z
    .object({
        ttft_ms: nonNegativeNumberSchema.optional(),
        tokens_per_second: nonNegativeNumberSchema.optional(),
        latency_ms_p50: nonNegativeNumberSchema.optional(),
        latency_ms_p95: nonNegativeNumberSchema.optional(),
        peak_memory_mb: nonNegativeNumberSchema.optional()
    })
    .strict();

const calibrationQualitySchema = z
    .object({
        overall_score: percentageScoreSchema.optional(),
        task_scores: z.record(nonEmptyStringSchema, percentageScoreSchema).optional(),
        check_pass_rate: z.number().finite().min(0).max(1).optional()
    })
    .strict();

const calibrationCheckResultTraceSchema = z
    .object({
        type: z.enum(['exact', 'contains', 'regex']),
        expected: nonEmptyStringSchema,
        weight: z.number().finite().positive(),
        passed: z.boolean(),
        error: nonEmptyStringSchema.optional()
    })
    .strict();

const calibrationPromptRunTraceSchema = z
    .object({
        prompt_id: nonEmptyStringSchema,
        task: nonEmptyStringSchema,
        latency_ms: nonNegativeNumberSchema,
        ttft_ms: nonNegativeNumberSchema.optional(),
        output_tokens: nonNegativeIntegerSchema,
        response_excerpt: z.string().optional(),
        check_results: z.array(calibrationCheckResultTraceSchema),
        check_pass_rate: z.number().finite().min(0).max(1)
    })
    .strict();

const calibrationTraceSchema = z
    .object({
        warmup_runs: nonNegativeIntegerSchema.optional(),
        measured_iterations: z.number().int().min(1).optional(),
        prompt_runs: z.array(calibrationPromptRunTraceSchema).optional(),
        error_code: nonEmptyStringSchema.optional()
    })
    .strict();

const calibrationModelResultSchema = z
    .object({
        model_identifier: nonEmptyStringSchema,
        status: z.enum(['success', 'failed', 'skipped', 'pending']),
        metrics: calibrationMetricsSchema.optional(),
        quality: calibrationQualitySchema.optional(),
        traces: calibrationTraceSchema.optional(),
        error: nonEmptyStringSchema.optional()
    })
    .strict()
    .superRefine((value, context) => {
        if (value.status === 'success' && !value.metrics) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['metrics'],
                message: 'metrics are required when status is success'
            });
        }

        if (value.status === 'failed' && !value.error) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['error'],
                message: 'error is required when status is failed'
            });
        }
    });

const calibrationSuiteMetadataSchema = z
    .object({
        path: nonEmptyStringSchema,
        total_prompts: nonNegativeIntegerSchema,
        task_breakdown: z.record(nonEmptyStringSchema, nonNegativeIntegerSchema)
    })
    .strict();

const calibrationSummarySchema = z
    .object({
        total_models: nonNegativeIntegerSchema,
        successful_models: nonNegativeIntegerSchema,
        failed_models: nonNegativeIntegerSchema,
        skipped_models: nonNegativeIntegerSchema,
        pending_models: nonNegativeIntegerSchema
    })
    .strict()
    .superRefine((value, context) => {
        const countedTotal =
            value.successful_models +
            value.failed_models +
            value.skipped_models +
            value.pending_models;

        if (countedTotal !== value.total_models) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['total_models'],
                message:
                    'total_models must equal successful_models + failed_models + skipped_models + pending_models'
            });
        }
    });

const calibrationResultSchema = z
    .object({
        schema_version: z.literal('1.0'),
        generated_at: isoDateTimeSchema,
        calibration_version: nonEmptyStringSchema,
        execution_mode: calibrationExecutionModeSchema,
        runtime: runtimeSchema,
        objective: calibrationObjectiveSchema,
        hardware: z
            .object({
                fingerprint: nonEmptyStringSchema.optional(),
                description: nonEmptyStringSchema.optional()
            })
            .strict()
            .default({}),
        suite: calibrationSuiteMetadataSchema,
        models: z.array(calibrationModelResultSchema),
        summary: calibrationSummarySchema
    })
    .strict();

const calibrationRouteSchema = z
    .object({
        primary: nonEmptyStringSchema,
        fallbacks: z.array(nonEmptyStringSchema),
        min_quality: percentageScoreSchema.optional(),
        rationale: nonEmptyStringSchema.optional()
    })
    .strict();

const calibrationPolicySchema = z
    .object({
        schema_version: z.literal('1.0'),
        generated_at: isoDateTimeSchema,
        objective: calibrationObjectiveSchema,
        source: z
            .object({
                calibration_version: nonEmptyStringSchema,
                calibration_result_path: nonEmptyStringSchema.optional()
            })
            .strict(),
        routing: z.record(nonEmptyStringSchema, calibrationRouteSchema),
        metadata: z
            .object({
                runtime: runtimeSchema.optional(),
                hardware_fingerprint: nonEmptyStringSchema.optional()
            })
            .strict()
            .optional()
    })
    .strict();

module.exports = {
    SUPPORTED_CALIBRATION_OBJECTIVES,
    SUPPORTED_CALIBRATION_EXECUTION_MODES,
    DEFAULT_CALIBRATION_TASK,
    calibrationObjectiveSchema,
    calibrationExecutionModeSchema,
    promptSuiteCheckSchema,
    promptSuiteEntrySchema,
    calibrationResultSchema,
    calibrationPolicySchema
};
