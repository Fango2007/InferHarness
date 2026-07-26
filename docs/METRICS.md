# InferHarness Metrics Specification

Status: Canonical specification

Specification version: 1.1

Canonical metric version: `metrics-v2`

Last updated: 2026-07-26

## 1. Purpose

This document is the source of truth for metrics produced, stored, aggregated,
compared, and displayed by InferHarness.

It defines:

- what each metric measures;
- where its measurement begins and ends;
- when the metric is applicable;
- its unit, formula, source, and aggregation rules;
- how missing and invalid measurements are represented;
- which metrics are primary outcomes, diagnostics, or guardrails;
- when results from different runs may be compared.

Schemas, backend calculations, built-in benchmark templates, UI labels, tests,
and documentation MUST follow this specification. A code change that alters a
metric definition MUST update this document and increment `metric_version`.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are normative.

## 2. Scope

This specification covers:

1. benchmark execution health;
2. model and provider response correctness;
3. tool-call correctness;
4. client-observed latency;
5. provider- or server-reported timing;
6. token counts and per-request generation efficiency;
7. response-size diagnostics and cost estimates;
8. load-test capacity and goodput;
9. manual qualitative evaluations;
10. benchmark-scoped host and accelerator telemetry.

Complete provider request and response schemas are outside this specification.
Provider-native fields used as metric sources and their canonical mappings are
defined here. Provider adapters are responsible for producing normalized events
and responses from which the remaining metrics can be measured.

### 2.1 Clean metrics foundation

`metrics-v2` is the first canonical metric contract that the application will
implement. Metric identifiers and persisted observations produced before this
contract are non-canonical implementation data.

The database MUST be reset before InferHarness begins recording canonical
`metrics-v2` observations. InferHarness MUST NOT provide compatibility aliases,
backfill old observations, or reinterpret historical metric values. After the
reset, application code, schemas, built-in templates, tests, and UI labels MUST
emit and consume only the identifiers and semantics defined here.

Before the first conforming application release records `metrics-v2` data, this
document MAY refine the foundation by incrementing `Specification version`
without changing `metric_version`. After canonical `metrics-v2` observations
exist, any semantic metric change requires a new metric version and MUST NOT
reinterpret the recorded values.

## 3. Design Principles

### 3.1 Keep metric families separate

InferHarness MUST NOT collapse correctness, reliability, latency, capacity,
cost, and manual quality into one universal score. These dimensions support
different decisions and may trade off against one another.

### 3.2 Separate observations from estimates

A directly observed or provider-reported measurement MUST be distinguishable
from a derived value or heuristic estimate.

Examples:

- a provider-reported model load duration is a measurement;
- a cold-start difference inferred from the first request is an estimate;
- input tokens divided by client-observed time to first output is a proxy, not
  measured prefill throughput.

### 3.3 Preserve provenance

Every metric definition MUST identify its source:

- `client_observed`;
- `provider_reported`;
- `server_reported`;
- `derived`;
- `heuristic`;
- `human_rated`;
- `host_telemetry`.

Metrics with different sources or definitions MUST NOT be presented as directly
comparable without a warning.

### 3.4 Make applicability explicit

An inapplicable metric is not a failure and is not zero.

Examples:

- time to first output is not measurable from a non-streaming response;
- tool-call correctness is not applicable when a dataset item has no tool-call
  expectation;
- provider token usage may be unavailable even when a request succeeds.

### 3.5 Preserve reproducibility

Metric results MUST retain enough run context to explain and reproduce them,
including the metric version, dataset identity and hash, model and server,
runtime parameters, stream mode, retry policy, concurrency, and cold/warm
policy.

## 4. Metric Observation Contract

Each metric observation has the following conceptual fields:

| Field | Requirement |
|---|---|
| `metric_id` | Stable snake-case identifier |
| `value` | Number or boolean; null when no value exists |
| `unit` | Unit declared by the metric definition |
| `status` | `measured`, `not_applicable`, `unavailable`, or `execution_error` |
| `reason` | Required when status is not `measured` |
| `source` | Provenance category from section 3.3 |
| `metric_version` | Definition version used for the observation |
| `provider_id` | Provider or server identity when source is provider- or server-reported |
| `provider_protocol` | Normalized protocol used to obtain the native field |
| `provider_version` | Provider or server version when known |
| `native_field` | Original provider field path when a native value was normalized |
| `native_value` | Original numeric or boolean value before normalization |
| `native_unit` | Original provider unit |
| `normalization` | Conversion applied to produce the canonical value |
| `accounting_scope` | Inclusion, overlap, candidate, modality, cache, or token-category semantics when relevant |

Using only `null` without a status and reason is insufficient for new
`metrics-v2` observations.

Provider provenance fields are required for `provider_reported` and
`server_reported` observations when the provider supplies the corresponding
information. `accounting_scope` is required whenever a native value can overlap
another count or can cover more than the normalized response, such as cached
tokens, hidden reasoning tokens, or multiple response candidates.

Configuration errors, such as an invalid expected regular expression or JSON
Schema, MUST fail validation before execution. They MUST NOT be recorded as a
model failure or an unavailable metric.

## 5. Timing Model

### 5.1 Canonical timestamps

The runner SHOULD capture the following monotonic timestamps:

| Timestamp | Definition |
|---|---|
| `t_operation_start` | Immediately before the first request attempt is dispatched |
| `t_attempt_start` | Immediately before an individual HTTP attempt is dispatched |
| `t_first_chunk` | First non-empty transport bytes received |
| `t_first_output` | First normalized, non-empty model output |
| `t_first_tool_call` | First normalized tool-call name or argument fragment |
| `t_tool_calls_ready` | All tool calls for the assistant turn are complete and parseable |
| `t_last_output` | Last normalized text or tool-call output event |
| `t_attempt_end` | Attempt completed, timed out, or failed |
| `t_operation_end` | Operation completed after retries or terminated |

All durations MUST use a monotonic clock. Wall-clock timestamps MAY be stored
for audit purposes but MUST NOT be used to calculate durations.

### 5.2 Meaningful output

`t_first_output` MUST ignore:

- HTTP headers;
- SSE comments and ping events;
- role-only deltas;
- empty text;
- stream-start metadata;
- usage-only events;
- terminal markers.

Text responses set `t_first_output` at the first non-empty text delta.
Tool-only responses set it at the first tool-call name or argument delta.

Because a provider chunk may contain zero, one, or multiple model tokens, the
canonical cross-provider name is `time_to_first_output_ms`. The UI MAY use
"TTFT" only for text-token streams whose event semantics support that label.

### 5.3 Terminal timing

`t_last_output` excludes terminal protocol markers such as `[DONE]` and an SSE
`message_stop` event that contains no model output. `t_operation_end` includes
the time required to finish or close the response.

## 6. Execution Health Metrics

Execution health describes whether InferHarness obtained and normalized a
response. It MUST remain separate from model correctness.

| Metric ID | Type | Definition | Primary aggregation |
|---|---|---|---|
| `request_success` | boolean | HTTP request completed with a successful provider status | Rates in section 12 |
| `stream_completed` | boolean | Stream reached a valid provider terminal state | Rates in section 12 |
| `response_normalization_success` | boolean | Provider response was converted to the canonical response shape without loss that prevents evaluation | Rates in section 12 |
| `attempt_count` | integer | Number of HTTP attempts made for the item | Mean, p95, max |
| `timeout_occurred` | boolean | Operation terminated because its timeout was reached | Rate |
| `retry_overhead_ms` | milliseconds | `operation_elapsed_ms - sum(attempt_elapsed_ms)` | Mean, p95 |

An item may have `request_success=true` and
`response_normalization_success=false`. This identifies a provider adapter or
protocol conformance problem instead of incorrectly reporting model failure.

## 7. Client-Observed Latency Metrics

| Metric ID | Source | Definition | Applicability | Preferred aggregation |
|---|---|---|---|---|
| `operation_elapsed_ms` | client observed | `t_operation_end - t_operation_start`, including retries and backoff | All attempted operations | p50, p95, p99, mean |
| `successful_attempt_latency_ms` | client observed | `t_attempt_end - t_attempt_start` for the successful attempt | Successful operations | p50, p95, p99, mean |
| `time_to_first_chunk_ms` | client observed | `t_first_chunk - t_attempt_start` | Streaming responses | p50, p95 |
| `time_to_first_output_ms` | client observed | `t_first_output - t_attempt_start` | Streaming responses with meaningful output | p50, p95, p99 |
| `time_to_first_tool_call_ms` | client observed | `t_first_tool_call - t_attempt_start` | Streamed tool-call responses | p50, p95 |
| `time_to_tool_calls_ready_ms` | client observed | `t_tool_calls_ready - t_attempt_start` | Streamed tool-call responses | p50, p95, p99 |
| `generation_window_ms` | derived | `t_last_output - t_first_output` | Streaming responses with at least two output tokens | p50, p95 |

`time_to_first_chunk_ms` is a transport diagnostic. It MUST NOT be displayed as
TTFT or time to first output.

`operation_elapsed_ms` measures user-visible resilience behavior.
`successful_attempt_latency_ms` measures the final successful inference
attempt. Server-performance comparisons SHOULD use the latter and MUST report
retry counts.

## 8. Provider- and Server-Reported Timing

These metrics are optional because not every provider exposes them.

| Metric ID | Source | Definition | Applicability | Preferred aggregation |
|---|---|---|---|---|
| `server_total_time_ms` | `server_reported` | Server-reported total processing duration | Server supplies an equivalent total | p50, p95, p99, mean |
| `server_queue_time_ms` | `server_reported` | Time waiting for scheduling or batching | Server exposes queue duration separately | p50, p95, p99, mean |
| `server_prefill_time_ms` | `server_reported` | Prompt evaluation or prefill duration | Server exposes prefill duration separately | p50, p95, p99, mean |
| `server_decode_time_ms` | `server_reported` | Output generation duration | Server exposes decode duration separately | p50, p95, p99, mean |
| `model_load_time_ms` | `server_reported` | Model load duration attributed to the request | Server attributes a load duration to the request | median, p95, max |

Provider-native fields MUST be converted to milliseconds once, in the provider
normalizer. The original field name, original unit, and provider protocol MUST
be retained as provenance.

Server-reported and client-observed timings MUST be labeled separately.
InferHarness MUST NOT use a provider-reported duration as a silent replacement
for client-observed latency.

### 8.1 Provider mapping policy

Every provider-native field considered for metric use MUST be classified as one
of:

| Classification | Rule |
|---|---|
| `exact` | Native semantics match a canonical metric. Normalize the value once and retain its native provenance. |
| `qualified` | Mapping is valid only when declared conditions hold, such as a single response candidate or a known token-accounting relationship. Record those conditions in `accounting_scope`. |
| `provider_only` | No canonical metric has equivalent semantics. Preserve the value in raw provider metadata, but do not aggregate it or present it as cross-provider evidence. |

A provider field MUST NOT become a canonical metric only because one provider
exposes it. A new canonical metric requires a stable definition, unit,
applicability rule, decision-making use, and aggregation policy.

Provider normalizers MUST:

1. apply only mappings registered in this document;
2. reject non-finite values and impossible negative counts or durations;
3. convert native units exactly once;
4. preserve the native field path, value, unit, protocol, and provider version;
5. emit `unavailable` rather than infer a provider-reported measurement from
   unrelated fields.

Updating a provider adapter for a renamed field does not change
`metric_version` when the canonical meaning is unchanged. Changing the meaning,
formula, unit, applicability, or comparison rules of a canonical metric
requires a new metric version.

### 8.2 Ollama timing mapping

The following mappings apply to native Ollama `/api/chat` and `/api/generate`
responses. Ollama emits these fields in the final streaming chunk or in the
complete non-streaming response.

| Native field | Native unit | Canonical metric | Conversion | Classification |
|---|---|---|---|---|
| `total_duration` | nanoseconds | `server_total_time_ms` | divide by `1,000,000` | `exact` |
| `load_duration` | nanoseconds | `model_load_time_ms` | divide by `1,000,000` | `exact` |
| `prompt_eval_duration` | nanoseconds | `server_prefill_time_ms` | divide by `1,000,000` | `exact` |
| `eval_duration` | nanoseconds | `server_decode_time_ms` | divide by `1,000,000` | `exact` |

These metrics describe Ollama's server-side work. They MUST NOT replace
`successful_attempt_latency_ms`, `time_to_first_output_ms`, or another
client-observed duration.

## 9. Token and Generation Metrics

### 9.1 Token counts

| Metric ID | Source | Unit | Definition | Applicability |
|---|---|---|---|---|
| `input_tokens` | `provider_reported`, `server_reported`, or `derived` | tokens | Total effective input tokens consumed by the request under the declared provider or tokenizer accounting model | Compatible provider total or registered component formula exists |
| `uncached_input_tokens` | `provider_reported`, `server_reported`, or `derived` | tokens | Input tokens outside separately reported cache-read and cache-write categories | Provider exposes cache accounting with a documented relationship |
| `cached_input_tokens` | `provider_reported` or `server_reported` | tokens | Input tokens read from an existing provider cache | Provider reports cache-read tokens |
| `cache_write_input_tokens` | `provider_reported` or `server_reported` | tokens | Input tokens processed to create or extend a provider cache | Provider reports cache-write tokens |
| `output_tokens` | `provider_reported`, `server_reported`, or `derived` | tokens | Generated output tokens under the declared provider or tokenizer accounting scope | Compatible provider usage or tokenizer count exists |
| `reasoning_tokens` | `provider_reported` or `server_reported` | tokens | Output tokens attributed to hidden reasoning or thinking when separately reported | Provider reports a reasoning-token breakdown |
| `tool_input_tokens` | `provider_reported` or `server_reported` | tokens | Input tokens attributed to provider-generated tool-use prompts when separately reported | Provider reports a tool-input breakdown |
| `total_tokens` | `provider_reported`, `server_reported`, or `derived` | tokens | Provider total when supplied; otherwise a sum only when all included components are compatible, non-overlapping, and use the same accounting source | Compatible provider total or registered component formula exists |

Every token count MUST record:

- `token_count_source`, such as provider usage or local tokenizer;
- tokenizer/model identity when known;
- whether component counts are included in, excluded from, or additive to
  `input_tokens`, `output_tokens`, and `total_tokens`;
- candidate and modality scope when a count spans multiple responses, images,
  audio, video, or tool content.

Token counts from different tokenizers SHOULD NOT be directly compared as if
they represented identical text units.

Preferred per-request aggregates are mean, median, p95, and sum. A sum is valid
as workload usage only when every included observation uses compatible
accounting semantics. Every aggregate MUST expose `valid_sample_count`.

`cached_input_tokens`, `reasoning_tokens`, and other component metrics MUST NOT
be added to a provider total when the provider defines them as subsets of that
total. InferHarness MUST use the provider's documented accounting relationship
instead of assuming that similarly named fields are additive.

When a provider does not expose cache writes separately,
`uncached_input_tokens` MAY include cache-write work. That limitation MUST be
recorded in `accounting_scope`; InferHarness MUST NOT synthesize a
`cache_write_input_tokens` observation.

### 9.2 Provider token mappings

| Provider protocol | Native field | Canonical metric | Classification | Accounting condition |
|---|---|---|---|---|
| Ollama native | `prompt_eval_count` | `input_tokens` | `exact` | Count applies to the evaluated prompt |
| Ollama native | `eval_count` | `output_tokens` | `exact` | Count applies to generated response tokens |
| OpenAI Chat Completions | `usage.prompt_tokens` | `input_tokens` | `exact` | Retain any cached-token breakdown as a subset |
| OpenAI Chat Completions | `usage.prompt_tokens_details.cached_tokens` | `cached_input_tokens` | `exact` | Included in `input_tokens` |
| OpenAI Chat Completions | `usage.prompt_tokens - usage.prompt_tokens_details.cached_tokens` | `uncached_input_tokens` | `exact` | Canonical observation source is `derived` |
| OpenAI Chat Completions | `usage.completion_tokens` | `output_tokens` | `exact` | Retain reasoning or other output details as subsets when supplied |
| OpenAI Responses | `usage.input_tokens` | `input_tokens` | `exact` | `cached_tokens` is a subset when reported |
| OpenAI Responses | `usage.input_tokens_details.cached_tokens` | `cached_input_tokens` | `exact` | Included in `input_tokens` |
| OpenAI Responses | `usage.input_tokens - usage.input_tokens_details.cached_tokens` | `uncached_input_tokens` | `exact` | Canonical observation source is `derived` |
| OpenAI Responses | `usage.output_tokens` | `output_tokens` | `exact` | Retain output-token details as subsets |
| OpenAI Responses | `usage.output_tokens_details.reasoning_tokens` | `reasoning_tokens` | `exact` | Included in `output_tokens` |
| Anthropic Messages | `usage.input_tokens` | `uncached_input_tokens` | `exact` | Cache read and cache write counts are separate |
| Anthropic Messages | `usage.cache_read_input_tokens` | `cached_input_tokens` | `exact` | Additive when calculating effective input |
| Anthropic Messages | `usage.cache_creation_input_tokens` | `cache_write_input_tokens` | `exact` | Additive when calculating effective input |
| Anthropic Messages | sum of the three input-token fields above | `input_tokens` | `exact` | `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`; canonical observation source is `derived` |
| Anthropic Messages | `usage.output_tokens` | `output_tokens` | `exact` | Use Anthropic's output accounting scope |
| Anthropic Messages | `usage.output_tokens_details.thinking_tokens` | `reasoning_tokens` | `exact` | Included in `output_tokens` |
| Gemini GenerateContent | `usageMetadata.promptTokenCount` | `input_tokens` | `exact` | Includes cached content in the effective prompt |
| Gemini GenerateContent | `usageMetadata.cachedContentTokenCount` | `cached_input_tokens` | `exact` | Included in `input_tokens` |
| Gemini GenerateContent | `usageMetadata.promptTokenCount - usageMetadata.cachedContentTokenCount` | `uncached_input_tokens` | `exact` | Canonical observation source is `derived` |
| Gemini GenerateContent | `usageMetadata.candidatesTokenCount` | `output_tokens` | `qualified` | Count spans all candidates; direct response comparison requires equivalent candidate scope |
| Gemini GenerateContent | `usageMetadata.thoughtsTokenCount` | `reasoning_tokens` | `exact` | Included in Gemini's reported total |
| Gemini GenerateContent | `usageMetadata.toolUsePromptTokenCount` | `tool_input_tokens` | `exact` | Record whether the provider includes it in prompt or total counts |
| Gemini GenerateContent | `usageMetadata.totalTokenCount` | `total_tokens` | `exact` | Provider total covers prompt, thoughts, and response candidates |

An adapter MUST derive a canonical total when this registry declares an exact
component formula, as it does for Anthropic input tokens. An adapter MAY derive
another total from documented non-overlapping provider components when no
provider total exists, but that new mapping MUST be added to this registry
before use. A derived total MUST use source `derived`, retain the component
observations, and record its formula in `accounting_scope`.

Provider-only usage metadata, including service tiers, modality breakdowns, and
candidate-level details without canonical equivalents, remains raw provenance
until this specification defines a corresponding metric.

### 9.3 Per-request generation efficiency

| Metric ID | Formula | Applicability |
|---|---|---|
| `per_request_output_tokens_per_second` | `output_tokens / (successful_attempt_latency_ms / 1000)` | Successful request with token usage |
| `time_per_output_token_ms` | `generation_window_ms / (output_tokens - 1)` | Streaming response with at least two output tokens |
| `decode_output_tokens_per_second` | `(output_tokens - 1) / (generation_window_ms / 1000)` | Same as above |
| `server_prefill_tokens_per_second` | `input_tokens / (server_prefill_time_ms / 1000)` | Exact server prefill timing and compatible token count available |
| `server_decode_tokens_per_second` | `output_tokens / (server_decode_time_ms / 1000)` | Exact server decode timing and compatible token count available |
| `output_input_token_ratio` | `output_tokens / input_tokens` | Both counts available and input is greater than zero |

The denominator subtracts one for client-observed decode throughput because the
first output token is accounted for by time to first output, not the subsequent
generation window.

InferHarness MUST NOT call `input_tokens / time_to_first_output` prefill
throughput. Time to first output includes network, queueing, tokenization,
prefill, and first-output generation.

The output token count used for client-observed generation metrics MUST
correspond to the output represented by the measured stream. If provider usage
includes hidden reasoning, cached, media, or other tokens that are not part of
the measured output window, these derived metrics are unavailable unless the
provider supplies a compatible count.

### 9.4 Response size

| Metric ID | Source | Definition |
|---|---|---|
| `output_character_count` | derived | Unicode code-point count of normalized answer text |
| `output_word_count` | derived | Word count under a declared segmentation method |

Word count is language- and segmentation-dependent. Results MUST record the
segmentation method and SHOULD NOT use word count for cross-language model
ranking. Token counts are preferred when the tokenizer provenance is known.

### 9.5 Cost

| Metric ID | Source | Definition |
|---|---|---|
| `estimated_api_cost_usd` | derived | Estimated provider charge for one request under a versioned pricing snapshot |
| `cost_per_successful_request_usd` | derived | Total measured API cost divided by successful request count |
| `cost_per_passing_result_usd` | derived | Total measured API cost divided by end-to-end passing result count |

Every cost estimate MUST record:

- currency;
- pricing source and retrieval date;
- pricing or catalog version;
- model billing identifier;
- billable token categories used in the calculation;
- excluded charges.

An unavailable price MUST produce an unavailable metric, not zero cost.
Local-server cost MUST NOT be estimated from API token pricing. Hardware,
energy, and amortization costs require a separately declared cost model.

## 10. Functional Correctness Metrics

Correctness metrics are evaluated only after response normalization succeeds.

| Metric ID | Type | Definition |
|---|---|---|
| `exact_match` | boolean | Answer equals the expected answer after trimming leading and trailing whitespace only |
| `normalized_exact_match` | boolean | Answer and expected answer match under an explicitly declared normalization profile |
| `required_terms_present` | boolean | Every required term or pattern is present according to the dataset comparator |
| `forbidden_terms_absent` | boolean | No forbidden term or pattern is present |
| `json_syntax_valid` | boolean | Entire answer is valid JSON without extracting fenced or surrounding text |
| `json_schema_valid` | boolean | Parsed JSON satisfies the prevalidated expected JSON Schema |
| `regex_match` | boolean | Answer satisfies the prevalidated expected regular expression |

Normalization for `normalized_exact_match` MUST be declared by the benchmark
dataset. Supported operations MAY include Unicode normalization, line-ending
normalization, whitespace folding, and case folding. InferHarness MUST NOT
silently apply these transformations to `exact_match`.

Required and forbidden term checks SHOULD support explicit literal,
word-boundary, and regular-expression modes. Plain substring matching MUST NOT
be presented as semantic correctness.

## 11. Tool-Call Metrics

### 11.1 Canonical representation

The provider normalizer MUST represent:

- no observed tool calls as an empty array;
- unavailable or unnormalizable tool-call data as null with an explicit metric
  status and reason.

Null MUST NOT be treated as an empty array when scoring an expected no-tool
case.

Tool-call identifiers supplied by providers are audit metadata. They are not
part of functional equality unless a benchmark explicitly declares otherwise.

### 11.2 Primary outcome

| Metric ID | Type | Definition |
|---|---|---|
| `tool_call_assertion_pass` | boolean | Actual and expected tool calls match in count, function names, and declared argument comparator |

Matching is order-independent by default. A benchmark MAY require order when
tool-call order is part of the behavior under test.

`tool_call_assertion_pass` is the primary tool-call correctness outcome. The
remaining metrics are diagnostics explaining a failure.

### 11.3 Diagnostic metrics

| Metric ID | Type | Definition |
|---|---|---|
| `tool_call_count` | integer | Number of normalized actual tool calls |
| `tool_selection_exact_match` | boolean | Actual and expected tool-name multisets are equal |
| `tool_selection_precision` | ratio | Correctly matched actual call names divided by actual call count |
| `tool_selection_recall` | ratio | Correctly matched expected call names divided by expected call count |
| `tool_arguments_json_valid` | boolean | Every tool-call argument payload is a parsed JSON value of the required shape |
| `tool_arguments_schema_valid` | boolean | Every matched call satisfies its declared tool input schema |
| `tool_arguments_match_expected` | boolean | Every expected call has a distinct actual call with structurally matching expected arguments |
| `missing_tool_call_count` | integer | Number of expected calls without a distinct match |
| `unexpected_tool_call_count` | integer | Number of actual calls without a distinct expected match |
| `duplicate_tool_call_count` | integer | Number of duplicate actual calls beyond expected multiplicity |

Precision and recall MUST use multiset matching so duplicate calls are not
silently collapsed.

Argument validity and expected-value equality are different questions:

- schema validity answers whether the call is executable under the tool
  contract;
- expected matching answers whether the model supplied the values required by
  the benchmark case.

## 12. Aggregation and Coverage

### 12.1 Required counts

Every aggregate MUST expose:

| Field | Definition |
|---|---|
| `expected_sample_count` | Samples scheduled by the benchmark plan |
| `attempted_sample_count` | Samples for which execution started |
| `completed_sample_count` | Samples with a completed normalized response |
| `valid_sample_count` | Samples with a measured value for this metric |
| `passed_sample_count` | Valid boolean samples whose value is true |
| `unavailable_sample_count` | Samples where the metric was applicable but unavailable |
| `not_applicable_sample_count` | Samples where the metric did not apply |

The field `count` MUST NOT be used without a qualified meaning.

### 12.2 Boolean rates

InferHarness MUST report:

```text
observed_pass_rate = passed_sample_count / valid_sample_count
coverage_rate = valid_sample_count / expected_sample_count
end_to_end_pass_rate = passed_sample_count / expected_sample_count
```

`observed_pass_rate` describes model behavior among measurable responses.
`coverage_rate` exposes missing evidence. `end_to_end_pass_rate` describes the
probability that the benchmark pipeline produced a passing result.

The UI MUST display `passed_sample_count / valid_sample_count` next to observed
pass rate. It MUST NOT multiply an observed pass rate by total or expected
sample count to reconstruct a numerator.

### 12.3 Numeric aggregates

Supported numeric aggregates are:

- mean;
- median;
- minimum;
- maximum;
- sum;
- population standard deviation;
- population variance;
- p50, p90, p95, and p99 using linear interpolation equivalent to R type 7.

Aggregates MUST use measured values only and MUST display `valid_sample_count`.

Percentiles MAY be calculated for small samples, but the UI MUST flag:

- p90 when fewer than 10 valid samples exist;
- p95 when fewer than 20 valid samples exist;
- p99 when fewer than 100 valid samples exist.

An arithmetic mean of per-request token rates describes mean per-request
experience. It MUST NOT be labeled system throughput.

## 13. Capacity and Load-Test Metrics

Capacity metrics apply only to a controlled load-test stage with declared
concurrency or request-rate policy. Sequential dataset loops MUST NOT report
system throughput.

| Metric ID | Formula or definition |
|---|---|
| `request_throughput_rps` | Completed requests divided by measurement-window duration |
| `output_token_throughput_tps` | Total output tokens divided by measurement-window duration |
| `input_token_throughput_tps` | Total input tokens divided by measurement-window duration |
| `max_in_flight_requests` | Maximum observed concurrent requests |
| `request_error_rate` | Failed requests divided by attempted requests |
| `request_timeout_rate` | Timed-out requests divided by attempted requests |
| `goodput_rps` | Requests meeting declared correctness and latency SLOs divided by measurement-window duration |

Warmup traffic MUST be excluded from the measurement window. The result MUST
record the offered load, concurrency, arrival policy, benchmark duration,
input-length distribution, output-length distribution, and stop behavior.

Capacity SHOULD be evaluated as a throughput-versus-latency curve across
multiple load levels rather than as one isolated number.

## 14. Cold Start and Model Load

Cold and warm samples SHOULD be declared by benchmark stage or explicit server
control. The first request MUST NOT automatically be assumed to be cold.

`model_load_time_ms` is canonical only when reported by the server.

An inferred cold-start difference MAY be stored as:

| Metric ID | Source | Definition |
|---|---|---|
| `estimated_cold_start_penalty_ms` | heuristic | Declared cold sample latency minus a declared warm baseline |

The result MUST include the basis metric, warm sample count, baseline
aggregation, and detection threshold. The UI MUST label the value as estimated.
It MUST NOT be merged with provider-reported model load time.

## 15. Manual Qualitative Evaluation

InferHarness currently uses 1-5 ratings for accuracy, relevance, coherence,
completeness, and helpfulness. These remain rubric-rated metrics and MUST be
distinguished from deterministic benchmark assertions.

Each manual evaluation MUST record:

- `rubric_version`;
- evaluator type: human or automated judge;
- evaluator identifier or anonymized stable identifier;
- the score for each dimension;
- optional rationale;
- source prompt and answer identity.

The five dimensions MUST remain visible individually.

An optional composite MAY be calculated only when its weights and rubric
version are stored:

```text
manual_quality_composite =
  sum(dimension_score * dimension_weight) / sum(dimension_weight)
```

Equal weighting MUST be explicit rather than assumed. Manual scores MUST NOT be
mixed into automated benchmark pass rates. Comparisons across evaluators SHOULD
include calibration or multiple ratings when the result drives a ranking or
release decision.

## 16. Host and Accelerator Telemetry

Host health snapshots are diagnostics, not benchmark metrics unless they are
sampled during the benchmark measurement window.

Benchmark-scoped telemetry MAY include:

- mean and p95 GPU utilization;
- peak GPU memory usage;
- mean CPU utilization;
- peak process or host memory usage;
- energy consumed and energy per successful request when supported.

Every telemetry result MUST identify the device, sampling interval, sampling
window, and whether the observed host is the inference server. Client-machine
telemetry MUST NOT be presented as remote server utilization.

## 17. Comparison Eligibility

The UI MUST warn or prevent direct comparison when runs differ in a way that
changes metric meaning.

At minimum, comparisons MUST consider:

- `metric_version`;
- normalized provider protocol;
- provider or API version;
- native-field mapping classification and accounting scope for provider metrics;
- model and model revision;
- server and server version;
- dataset identity and content hash;
- runtime parameters;
- streaming mode;
- retry policy;
- cold/warm policy;
- concurrency or request rate;
- token-count source and tokenizer;
- tool declarations and tool-choice policy.

Correctness can be compared only against equivalent expectations. Capacity can
be compared only under equivalent offered load and workload distributions.

## 18. Default Metric Sets

### 18.1 Non-streaming functional benchmark

- `request_success`
- `response_normalization_success`
- `operation_elapsed_ms`
- `successful_attempt_latency_ms`
- `input_tokens`
- `output_tokens`
- task-specific correctness metrics

Time to first output, TPOT, and client decode rate are not applicable.

### 18.2 Streaming chat benchmark

- metrics from the non-streaming set;
- `stream_completed`;
- `time_to_first_chunk_ms`;
- `time_to_first_output_ms`;
- `time_per_output_token_ms`;
- `decode_output_tokens_per_second`.

### 18.3 Tool-call benchmark

- execution health metrics;
- `operation_elapsed_ms`;
- `time_to_first_output_ms` when streaming;
- `time_to_tool_calls_ready_ms` when streaming;
- `tool_call_assertion_pass`;
- all tool-call diagnostics from section 11.3.

### 18.4 Capacity benchmark

- execution health rates;
- p50, p95, and p99 latency metrics;
- request throughput;
- input and output token throughput;
- goodput;
- declared load and workload context.

## 19. Acceptance Requirements

An implementation conforms to this specification when:

1. every emitted metric has a definition, unit, source, applicability rule, and
   metric version;
2. first transport bytes cannot be reported as time to first output unless they
   contain normalized model output;
3. decode throughput excludes the first output token from its numerator;
4. retries expose operation latency separately from attempt latency;
5. unavailable and not-applicable observations are distinguishable;
6. boolean aggregates expose pass, valid, expected, and coverage counts;
7. no UI pass numerator is reconstructed from incompatible denominators;
8. tool argument schema validity is separate from expected-value matching;
9. sequential runs are not labeled as system throughput;
10. provider-native values are emitted only through registered exact or
    qualified mappings;
11. token component counts preserve their inclusion and overlap semantics;
12. no non-canonical metric observations remain after the pre-`metrics-v2`
    database reset.

## 20. References

- [NVIDIA NIM LLM benchmarking metric definitions](https://docs.nvidia.com/nim/benchmarking/llm/latest/metrics.html)
- [NVIDIA NIM benchmarking parameters and best practices](https://docs.nvidia.com/nim/benchmarking/llm/latest/parameters.html)
- [SGLang serving benchmark metric definitions](https://github.com/sgl-project/sglang/blob/main/docs/developer_guide/bench_serving.md)
- [Ollama API usage fields](https://docs.ollama.com/api/usage)
- [OpenAI Responses API reference](https://platform.openai.com/docs/api-reference/responses/object)
- [Anthropic Messages API reference](https://docs.anthropic.com/en/api/messages)
- [Gemini GenerateContent usage metadata](https://ai.google.dev/api/generate-content#UsageMetadata)
- [RFC 2119 requirement keywords](https://www.rfc-editor.org/rfc/rfc2119)
