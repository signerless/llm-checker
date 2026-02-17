const crypto = require('crypto');

const SEVERITY_BY_CODE = {
    MODEL_DENIED: 'high',
    MODEL_NOT_ALLOWED: 'high',
    BACKEND_NOT_ALLOWED: 'high',
    MODEL_NOT_LOCAL: 'high',
    LICENSE_NOT_APPROVED: 'high',
    LICENSE_MISSING: 'high',
    MODEL_TOO_LARGE: 'medium',
    MODEL_TOO_MANY_PARAMS: 'medium',
    INSUFFICIENT_RAM: 'medium',
    QUANTIZATION_NOT_ALLOWED: 'medium',
    MODEL_SIZE_UNKNOWN: 'low',
    MODEL_PARAMS_UNKNOWN: 'low',
    QUANTIZATION_UNKNOWN: 'low',
    BACKEND_UNKNOWN: 'low',
    RAM_UNKNOWN: 'low'
};

const RECOMMENDATIONS_BY_CODE = {
    MODEL_DENIED: 'Select a model that is not in the deny list or update policy approval scope.',
    MODEL_NOT_ALLOWED: 'Use an allowlisted model identifier/tag or extend rules.models.allow.',
    BACKEND_NOT_ALLOWED: 'Switch to an approved runtime backend or update rules.runtime.required_backends.',
    MODEL_NOT_LOCAL: 'Use a local model/runtime path or disable rules.runtime.local_only.',
    LICENSE_NOT_APPROVED: 'Use a model with an approved license or update rules.compliance.approved_licenses.',
    LICENSE_MISSING: 'Populate license metadata for this model before production use.',
    MODEL_TOO_LARGE: 'Select a smaller model or increase rules.models.max_size_gb.',
    MODEL_TOO_MANY_PARAMS: 'Select a model with fewer parameters or increase rules.models.max_params_b.',
    INSUFFICIENT_RAM: 'Use a smaller model/quantization or increase available system memory.',
    QUANTIZATION_NOT_ALLOWED: 'Switch to an approved quantization in rules.models.allowed_quantizations.',
    MODEL_SIZE_UNKNOWN: 'Add model size metadata (size_gb/size) so policy can evaluate it deterministically.',
    MODEL_PARAMS_UNKNOWN: 'Add parameter metadata (params_b) to model metadata.',
    QUANTIZATION_UNKNOWN: 'Add quantization metadata (quant/quantization) to model metadata.',
    BACKEND_UNKNOWN: 'Provide runtime backend context in policy evaluation inputs.',
    RAM_UNKNOWN: 'Provide system RAM metadata in policy evaluation context.'
};

function normalizeValue(value, fallback = 'unknown') {
    if (value === undefined || value === null) return fallback;
    const text = String(value).trim();
    return text.length > 0 ? text : fallback;
}

function csvValue(value) {
    const text = String(value ?? '');
    if (text.includes(',') || text.includes('"') || text.includes('\n')) {
        return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
}

function deterministicRuleId(code, path) {
    const input = `${normalizeValue(code)}|${normalizeValue(path)}`;
    const digest = crypto.createHash('sha1').update(input).digest('hex').slice(0, 12).toUpperCase();
    return `LLMCHECK-${digest}`;
}

function getSeverityForCode(code) {
    return SEVERITY_BY_CODE[code] || 'medium';
}

function getRecommendationForCode(code) {
    return RECOMMENDATIONS_BY_CODE[code] || 'Review policy rule and model metadata to remediate this violation.';
}

function sarifLevelFromSeverity(severity) {
    switch (severity) {
        case 'critical':
        case 'high':
            return 'error';
        case 'medium':
            return 'warning';
        default:
            return 'note';
    }
}

function toFindingRecord(entry, generatedAt) {
    const violation = entry?.violation || {};
    const code = normalizeValue(violation.code, 'UNKNOWN');
    const rulePath = normalizeValue(violation.path, 'policy');
    const severity = getSeverityForCode(code);

    return {
        generated_at: generatedAt,
        status: normalizeValue(entry?.status, 'active'),
        model_identifier: normalizeValue(entry?.model_identifier),
        model_name: normalizeValue(entry?.model_name),
        source: normalizeValue(entry?.source),
        registry: normalizeValue(entry?.registry),
        version: normalizeValue(entry?.version),
        license: normalizeValue(entry?.license),
        digest: normalizeValue(entry?.digest),
        violation_code: code,
        rule_path: rulePath,
        rule_id: deterministicRuleId(code, rulePath),
        severity,
        message: normalizeValue(violation.message, 'Policy violation detected.'),
        expected: normalizeValue(violation.expected, ''),
        actual: normalizeValue(violation.actual, ''),
        recommendation: getRecommendationForCode(code),
        exception_model: normalizeValue(entry?.exception?.model, ''),
        exception_reason: normalizeValue(entry?.exception?.reason, ''),
        exception_approver: normalizeValue(entry?.exception?.approver, ''),
        exception_expires_at: normalizeValue(entry?.exception?.expires_at, '')
    };
}

function extractHardwareSummary(hardware = {}) {
    return {
        cpu: normalizeValue(hardware?.cpu?.brand || hardware?.cpu?.model),
        cpu_cores: hardware?.cpu?.cores ?? 'unknown',
        memory_gb: hardware?.memory?.total ?? 'unknown',
        gpu: normalizeValue(hardware?.gpu?.model),
        gpu_vram_gb: hardware?.gpu?.vram ?? 'unknown',
        best_backend: normalizeValue(hardware?.summary?.bestBackend),
        os_platform: normalizeValue(hardware?.os?.platform),
        os_release: normalizeValue(hardware?.os?.release)
    };
}

function buildComplianceReport({
    commandName,
    policyPath,
    policy,
    evaluation,
    enforcement,
    runtimeContext,
    options,
    hardware,
    generatedAt
}) {
    const timestamp = generatedAt || new Date().toISOString();
    const findings = Array.isArray(evaluation?.findings)
        ? evaluation.findings.map((entry) => toFindingRecord(entry, timestamp))
        : [];

    const activeCount = findings.filter((entry) => entry.status === 'active').length;
    const suppressedCount = findings.filter((entry) => entry.status === 'suppressed').length;

    return {
        schema_version: '1.0',
        generated_at: timestamp,
        command: normalizeValue(commandName),
        policy: {
            path: normalizeValue(policyPath),
            org: normalizeValue(policy?.org),
            mode: normalizeValue(policy?.mode),
            on_violation: normalizeValue(policy?.enforcement?.on_violation, 'error'),
            allow_exceptions: policy?.enforcement?.allow_exceptions === true,
            reporting_formats: Array.isArray(policy?.reporting?.formats)
                ? policy.reporting.formats
                : []
        },
        enforcement: {
            should_block: Boolean(enforcement?.shouldBlock),
            exit_code: enforcement?.exitCode ?? 0,
            has_failures: Boolean(enforcement?.hasFailures),
            mode: normalizeValue(enforcement?.mode, normalizeValue(policy?.mode)),
            on_violation: normalizeValue(enforcement?.onViolation, 'error')
        },
        runtime: {
            backend: normalizeValue(runtimeContext?.backend),
            runtime_backend: normalizeValue(runtimeContext?.runtimeBackend),
            ram_gb: runtimeContext?.ramGB ?? 'unknown'
        },
        hardware: extractHardwareSummary(hardware),
        options: options || {},
        summary: {
            total_checked: evaluation?.totalChecked ?? 0,
            pass_count: evaluation?.passCount ?? 0,
            fail_count: evaluation?.failCount ?? 0,
            active_violations: activeCount,
            suppressed_violations: suppressedCount,
            exceptions_applied: evaluation?.exceptionsAppliedCount ?? 0,
            top_violations: Array.isArray(evaluation?.topViolations) ? evaluation.topViolations : []
        },
        findings
    };
}

function reportToJson(report) {
    return JSON.stringify(report, null, 2);
}

function reportToCsv(report) {
    const headers = [
        'generated_at',
        'command',
        'policy_path',
        'policy_mode',
        'on_violation',
        'total_checked',
        'pass_count',
        'fail_count',
        'status',
        'model_identifier',
        'model_name',
        'source',
        'registry',
        'version',
        'license',
        'digest',
        'violation_code',
        'rule_path',
        'rule_id',
        'severity',
        'message',
        'expected',
        'actual',
        'recommendation',
        'exception_model',
        'exception_reason',
        'exception_approver',
        'exception_expires_at'
    ];

    const rows = [headers.join(',')];

    if (!Array.isArray(report.findings) || report.findings.length === 0) {
        rows.push(
            [
                report.generated_at,
                report.command,
                report.policy?.path,
                report.policy?.mode,
                report.policy?.on_violation,
                report.summary?.total_checked,
                report.summary?.pass_count,
                report.summary?.fail_count,
                'compliant',
                '',
                '',
                '',
                '',
                '',
                '',
                '',
                '',
                '',
                '',
                '',
                'No policy violations detected.',
                '',
                '',
                '',
                '',
                '',
                '',
                ''
            ]
                .map(csvValue)
                .join(',')
        );

        return rows.join('\n');
    }

    report.findings.forEach((finding) => {
        rows.push(
            [
                finding.generated_at,
                report.command,
                report.policy?.path,
                report.policy?.mode,
                report.policy?.on_violation,
                report.summary?.total_checked,
                report.summary?.pass_count,
                report.summary?.fail_count,
                finding.status,
                finding.model_identifier,
                finding.model_name,
                finding.source,
                finding.registry,
                finding.version,
                finding.license,
                finding.digest,
                finding.violation_code,
                finding.rule_path,
                finding.rule_id,
                finding.severity,
                finding.message,
                finding.expected,
                finding.actual,
                finding.recommendation,
                finding.exception_model,
                finding.exception_reason,
                finding.exception_approver,
                finding.exception_expires_at
            ]
                .map(csvValue)
                .join(',')
        );
    });

    return rows.join('\n');
}

function reportToSarif(report) {
    const findings = Array.isArray(report.findings) ? report.findings : [];
    const rulesMap = new Map();

    findings.forEach((finding) => {
        if (!rulesMap.has(finding.rule_id)) {
            rulesMap.set(finding.rule_id, {
                id: finding.rule_id,
                name: finding.violation_code,
                shortDescription: {
                    text: finding.violation_code
                },
                fullDescription: {
                    text: finding.message
                },
                help: {
                    text: finding.recommendation
                },
                properties: {
                    severity: finding.severity,
                    rulePath: finding.rule_path,
                    code: finding.violation_code
                }
            });
        }
    });

    const results = findings.map((finding) => {
        const level = finding.status === 'suppressed' ? 'note' : sarifLevelFromSeverity(finding.severity);
        const messagePrefix = finding.status === 'suppressed' ? '[suppressed by exception] ' : '';

        return {
            ruleId: finding.rule_id,
            level,
            message: {
                text: `${messagePrefix}${finding.message}`
            },
            locations: [
                {
                    physicalLocation: {
                        artifactLocation: {
                            uri: finding.model_identifier
                        },
                        region: {
                            startLine: 1
                        }
                    }
                }
            ],
            properties: {
                modelName: finding.model_name,
                modelSource: finding.source,
                policyPath: finding.rule_path,
                expected: finding.expected,
                actual: finding.actual,
                recommendation: finding.recommendation,
                status: finding.status,
                exceptionReason: finding.exception_reason
            },
            partialFingerprints: {
                ruleFingerprint: finding.rule_id,
                modelFingerprint: `${finding.model_identifier}:${finding.violation_code}`
            }
        };
    });

    const sarif = {
        version: '2.1.0',
        $schema:
            'https://json.schemastore.org/sarif-2.1.0.json',
        runs: [
            {
                tool: {
                    driver: {
                        name: 'llm-checker-policy',
                        version: '1.0.0',
                        informationUri: 'https://github.com/Pavelevich/llm-checker',
                        rules: Array.from(rulesMap.values())
                    }
                },
                invocations: [
                    {
                        executionSuccessful: true,
                        commandLine: `llm-checker ${report.command}`,
                        startTimeUtc: report.generated_at
                    }
                ],
                results,
                properties: {
                    policyPath: report.policy?.path,
                    policyMode: report.policy?.mode,
                    totalChecked: report.summary?.total_checked,
                    passCount: report.summary?.pass_count,
                    failCount: report.summary?.fail_count,
                    activeViolations: report.summary?.active_violations,
                    suppressedViolations: report.summary?.suppressed_violations
                }
            }
        ]
    };

    return JSON.stringify(sarif, null, 2);
}

function serializeComplianceReport(report, format = 'json') {
    const normalized = normalizeValue(format, 'json').toLowerCase();

    if (normalized === 'json') return reportToJson(report);
    if (normalized === 'csv') return reportToCsv(report);
    if (normalized === 'sarif') return reportToSarif(report);

    throw new Error(`Unsupported report format: ${format}`);
}

module.exports = {
    buildComplianceReport,
    serializeComplianceReport,
    deterministicRuleId,
    getSeverityForCode,
    getRecommendationForCode
};
