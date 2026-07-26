# InferHarness Application Parameter Specification

Status: Draft foundation

Last updated: 2026-07-26

## 1. Purpose

This document defines the canonical parameter contract that InferHarness should
use across the UI, API, benchmark documents, provider adapters, persistence, and
result evidence.

The contract covers values that configure:

- model inference;
- response format, tool use, and reasoning;
- request execution and benchmark orchestration;
- inference-server connectivity and authentication;
- local application operation.

This specification supports the [product roadmap](ROADMAP.md), especially the
Milestone 1 requirements for consistent cross-provider parameter handling,
comparison eligibility, auditable evidence, and schema/runtime conformance.

The JSON Schemas under [docs/schemas](schemas/README.md) remain the source of
truth for serialized document shapes. This document defines the semantics those
schemas and their runtime copies must implement.

## 2. Normative Language

The terms MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are normative.

- **MUST** and **MUST NOT** describe requirements for a conforming
  implementation.
- **SHOULD** and **SHOULD NOT** describe the expected behavior unless a
  documented reason justifies an exception.
- **MAY** describes optional behavior.

## 3. Scope and Boundaries

### 3.1 Parameter classes

InferHarness parameters belong to one of four classes:

| Class | Purpose | Canonical owner | Included in run evidence |
|---|---|---|---|
| Inference | Controls model generation and response behavior | Runtime profile | Yes |
| Execution | Controls retries, timeout, cancellation, ordering, and concurrency | Runtime profile, template, or benchmark plan | Yes |
| Target | Identifies and configures the model/server operation | Model profile and operation specification | Yes, with secrets redacted |
| Application | Controls the local InferHarness process and storage | Environment or app settings | Only when it affects interpretation |

The same parameter MUST NOT have two active owners. For example,
`request_timeout_ms` belongs to the execution policy and MUST NOT also appear in
the inference parameter object.

### 3.2 Values that are not inference parameters

Model identity and deployment traits such as model revision, context window,
precision, format, and quantization are target metadata. They MUST be captured
in the model snapshot, not presented as generation controls.

In particular, the existing `quantization_level` field is not part of the
canonical inference contract. New benchmark records MUST use the model
architecture and precision fields instead.

Prompts, messages, tool definitions, expected answers, and evaluation rules are
benchmark inputs. They are not runtime parameters even though provider adapters
include them in request payloads.

Test-runner-only switches, fixture controls, and development flags are outside
this application contract.

### 3.3 Current operation boundary

The complete parameter contract in this version applies to
`chat_completion`. Other operation families MUST define an operation-specific
contract before the application advertises complete support for them.

The current operation vocabulary also contains `completion`, `embedding`,
`list_models`, and `healthcheck`. Their presence in a schema does not by itself
mean that their full parameter surfaces are supported.

## 4. Canonical Parameter Lifecycle

Every explicitly supplied inference or execution parameter MUST pass through the
following lifecycle:

1. **Requested**: preserve the user or document value without provider
   translation.
2. **Normalized**: apply canonical names, types, units, and unset semantics.
3. **Validated**: reject invalid values and invalid combinations.
4. **Resolved**: apply documented precedence and operation requirements.
5. **Capability checked**: determine whether the selected model, server, and
   protocol can honor the parameter.
6. **Mapped**: translate the canonical value to the provider-native request.
7. **Applied**: record what was sent, omitted, transformed, or supplied by the
   provider.
8. **Persisted**: store enough sanitized evidence to explain and reproduce the
   request.

The application MUST NOT silently clamp, rename, omit, or replace an explicitly
requested value. Every transformation or omission MUST produce a parameter
resolution record.

### 4.1 Unset and null

At input boundaries, an omitted field and `null` both mean **unset**. The
normalized canonical object MUST omit unset fields.

Unset means that InferHarness does not request a value. It does not mean zero,
false, an empty string, or an InferHarness default.

When a provider applies its own default to an unset field:

- InferHarness MUST identify the value as a provider default if the effective
  value is reported or authoritatively known;
- InferHarness MUST use `unknown` when the effective value cannot be proven;
- InferHarness MUST NOT represent a provider default as a user-requested value.

### 4.2 Defaults

InferHarness MUST NOT insert hidden generation defaults.

A named preset MAY contain explicit values such as temperature or output token
limit. Selecting that preset makes those values requested parameters and they
must be visible before execution.

If a provider requires a parameter, InferHarness MUST require an explicit value
or a visible, versioned preset value. For example, an adapter MUST NOT silently
invent an Anthropic `max_tokens` value.

### 4.3 Precedence and conflicts

Parameters resolve in this order:

1. template operation and capability requirements;
2. selected runtime profile;
3. explicit run overrides;
4. dataset-item request contracts for item-scoped values only.

Dataset items may own `tools`, `tool_choice`, and an expected response schema
because those values can vary by item. They MUST NOT override sampling,
reasoning, timeout, retry, or concurrency parameters.

A later source may override an earlier value only when that override is allowed
by the ownership rules above. Any other conflict MUST fail preflight with both
sources identified.

The resolved values MUST be copied into the immutable test instantiation before
execution. Later edits to a preset, profile, template, plan, server, or model
record MUST NOT change an existing instantiation.

## 5. Inference Parameters

### 5.1 Core generation

| Canonical name | Type and canonical constraint | Meaning |
|---|---|---|
| `temperature` | number, `0..2` | Sampling temperature. `0` remains an explicit value. |
| `top_p` | number, `0..1` | Nucleus-sampling probability mass. |
| `top_k` | integer, `>= 1` | Restrict sampling to the highest-probability tokens. |
| `min_p` | number, `0..1` | Minimum token probability relative to the most likely token. |
| `seed` | signed safe integer | Requests deterministic sampling where supported; it does not guarantee reproducibility. |
| `max_output_tokens` | integer, `>= 1` | Maximum tokens generated for one candidate, including provider-counted reasoning tokens where applicable. |
| `stop_sequences` | non-empty string array with unique entries | Stops generation when a listed sequence is produced. |
| `presence_penalty` | number, `-2..2` | Penalizes tokens based on prior presence. |
| `frequency_penalty` | number, `-2..2` | Penalizes tokens based on prior frequency. |
| `repetition_penalty` | number, `> 0` | Provider-style multiplicative repetition penalty. |

Canonical validation establishes type and general semantic constraints.
Provider/model limits may be narrower and MUST be checked separately.

`max_output_tokens` replaces the ambiguous current name `max_tokens`.
`stop_sequences` replaces the current `stop` name and is always normalized to
an array.

`seed` MUST be recorded as a requested determinism control. A result MUST NOT be
described as reproducible solely because the same seed was used; model revision,
server version, provider behavior, concurrency, and other target state can
change the output.

### 5.2 Response behavior

| Canonical name | Type and allowed values | Meaning |
|---|---|---|
| `stream` | boolean | Requests a streamed transport response. |
| `response_format` | `text`, `json_object`, or `json_schema` | Requests the provider response mode. |
| `response_schema` | JSON Schema object | Schema supplied when `response_format` is `json_schema`. |
| `return_logprobs` | boolean | Requests output-token log probabilities. |
| `top_logprobs` | integer, `>= 0` | Requests alternatives per output token when log probabilities are enabled. |

`response_schema` MUST be present only with `response_format: json_schema`.
`top_logprobs` MUST be present only when `return_logprobs` is true.

Streaming is a transport parameter and must not change functional expectations.
If a provider cannot return equivalent normalized evidence in streaming mode,
streaming and non-streaming results are not comparison-equivalent.

InferHarness SHOULD initially constrain provider candidate count to one. A
future multi-candidate feature must specify candidate identity, metrics,
evaluation, cost, and aggregation before exposing a `candidate_count` control.

### 5.3 Tool use

| Canonical name | Type and allowed values | Meaning |
|---|---|---|
| `tool_choice` | `auto`, `none`, `required`, or `{ "name": string }` | Controls whether or which declared tool may be called. |
| `parallel_tool_calls` | boolean | Allows more than one tool call in one assistant turn. |

Tool declarations are item inputs and MUST be present when `tool_choice` is
`required` or names a tool. A named choice MUST reference a declared tool.

Provider-native tool-choice values MUST normalize to this vocabulary before
persistence. Provider-specific tool modes without a canonical semantic match
belong under provider extensions.

### 5.4 Reasoning

| Canonical name | Type and allowed values | Meaning |
|---|---|---|
| `reasoning_mode` | `disabled`, `enabled`, or `adaptive` | Controls whether an explicit reasoning feature is requested. |
| `reasoning_effort` | `minimal`, `low`, `medium`, or `high` | Requests a qualitative reasoning effort when supported. |
| `reasoning_token_budget` | integer, `>= 1` | Requests an explicit provider-counted reasoning budget. |
| `include_reasoning` | boolean | Requests provider-exposed reasoning content in the response. |

These parameters describe explicit provider reasoning features. They do not
claim that ordinary model generation lacks internal reasoning.

The application MUST validate provider/model combinations between reasoning
mode, effort, token budget, sampling controls, tool choice, and output-token
limits. It MUST NOT assume those combinations are portable.

Provider effort levels that have no canonical equivalent, such as an additional
provider-specific tier, MUST use a namespaced extension unless this contract is
deliberately revised.

### 5.5 Provider extensions

Provider-specific parameters are allowed only under:

```json
{
  "provider_extensions": {
    "<protocol-or-provider-id>": {
      "<native_parameter>": "<value>"
    }
  }
}
```

Extensions MUST:

- be namespaced by stable provider or protocol identifier;
- be schema validated;
- be visible in the UI and persisted evidence;
- never override a canonical parameter;
- declare whether they affect comparison eligibility;
- fail preflight when supplied to another provider.

An extension that acquires stable, equivalent semantics across supported
providers SHOULD be promoted to the canonical contract through normal
specification and schema change control.

## 6. Provider Mapping and Support

Provider support is determined by the selected model, server, protocol, and API
version, not by provider name alone.

Each adapter MUST report one support state per requested parameter:

| State | Meaning |
|---|---|
| `exact` | Native field has the canonical meaning and the requested value is sent unchanged. |
| `qualified` | Mapping is usable but has a documented semantic, range, accounting, or determinism difference. |
| `unsupported` | The selected target cannot honor the parameter. |
| `unknown` | InferHarness cannot establish support reliably. |

The following table defines the expected first-party mappings. A cell describes
the native field, not unconditional support by every model or server.

| Canonical parameter | OpenAI Chat-compatible | Ollama Chat | Anthropic Messages | Gemini GenerateContent |
|---|---|---|---|---|
| `temperature` | `temperature` | `options.temperature` | `temperature` | `generationConfig.temperature` |
| `top_p` | `top_p` | `options.top_p` | `top_p` | `generationConfig.topP` |
| `top_k` | extension/capability dependent | `options.top_k` | `top_k` | `generationConfig.topK` |
| `min_p` | extension/capability dependent | `options.min_p` | unsupported | unsupported |
| `seed` | `seed`, capability dependent | `options.seed` | unsupported | `generationConfig.seed` |
| `max_output_tokens` | `max_tokens` or protocol-version equivalent | `options.num_predict` | `max_tokens` | `generationConfig.maxOutputTokens` |
| `stop_sequences` | `stop` | `options.stop` | `stop_sequences` | `generationConfig.stopSequences` |
| `presence_penalty` | `presence_penalty` | extension/capability dependent | unsupported | `generationConfig.presencePenalty` |
| `frequency_penalty` | `frequency_penalty` | extension/capability dependent | unsupported | `generationConfig.frequencyPenalty` |
| `repetition_penalty` | extension/capability dependent | `options.repeat_penalty` | unsupported | unsupported |
| `stream` | `stream` | `stream` | `stream` | streaming operation endpoint |
| `response_format` / `response_schema` | `response_format` | protocol/capability dependent | provider tool or output-format capability | `responseMimeType` / `responseJsonSchema` |
| `return_logprobs` / `top_logprobs` | `logprobs` / `top_logprobs` | protocol/capability dependent | unsupported | `responseLogprobs` / `logprobs` |
| `tool_choice` | `tool_choice` | protocol/capability dependent | `tool_choice` | `toolConfig.functionCallingConfig` |
| `parallel_tool_calls` | `parallel_tool_calls` when supported | capability dependent | capability dependent | capability dependent |
| reasoning parameters | protocol/model-specific reasoning fields | `think` or provider extension | `thinking` and/or `output_config.effort` | `thinkingConfig` |

The OpenAI Chat-compatible column describes the base wire family, not a promise
that every compatible provider preserves every OpenAI field. Providers with
known deviations require an explicit adapter profile.

### 6.1 Mistral profile

Mistral uses `/v1/chat/completions` but differs from the generic OpenAI mapping
in several material ways:

| Canonical parameter | Mistral mapping | Support and qualification |
|---|---|---|
| `temperature` | `temperature` | `exact`; model defaults and recommended ranges vary |
| `top_p` | `top_p` | `exact`; Mistral recommends changing temperature or top-p, not both |
| `seed` | `random_seed` | `exact`; sending generic `seed` is not conforming |
| `max_output_tokens` | `max_tokens` | `exact`, subject to model context limits |
| `stop_sequences` | `stop` | `exact` |
| `presence_penalty` | `presence_penalty` | `exact`, subject to model limits |
| `frequency_penalty` | `frequency_penalty` | `exact`, subject to model limits |
| `stream` | `stream` | `exact` |
| `response_format` | `response_format.type` | `text`, `json_object`, and `json_schema` are supported |
| `response_schema` | `response_format.json_schema` | `exact` when JSON Schema mode is supported by the selected model |
| `tool_choice` | `tool_choice` | `auto`, `none`, `required`/`any`, and named tools map to the canonical vocabulary |
| `parallel_tool_calls` | `parallel_tool_calls` | `exact`; native default is true and MUST NOT be mistaken for a requested value |
| `reasoning_effort` | `reasoning_effort` | Canonical levels map directly when supported; native `none` represents disabled reasoning |
| `reasoning_mode` | derived from `reasoning_effort` | `disabled` maps to `none`; `enabled` requires an explicit non-`none` effort; `adaptive` is unsupported |

Mistral does not document portable chat-completion mappings for `top_k`,
`min_p`, `repetition_penalty`, `return_logprobs`, or `top_logprobs`. They MUST
remain `unsupported` or `unknown` until a model/API capability establishes a
mapping.

Mistral-native `xhigh` reasoning is a provider extension because the canonical
effort vocabulary ends at `high`. The native `safe_prompt`, `guardrails`, and
`prompt_mode` fields may alter the effective instructions or safety behavior
and therefore MUST be explicit provider extensions that affect comparability.
`prompt_cache_key` and `prediction` may alter cost or latency and MUST be
retained as measurement-condition extensions. InferHarness continues to
constrain native `n` to one as required by section 5.2.

### 6.2 DeepSeek profile

DeepSeek exposes an OpenAI-style `/chat/completions` API, but its current
thinking and non-thinking modes have different parameter semantics:

| Canonical parameter | DeepSeek mapping | Support and qualification |
|---|---|---|
| `temperature` | `temperature` | `exact` only in non-thinking mode; ignored without error in thinking mode |
| `top_p` | `top_p` | `exact` only in non-thinking mode; ignored without error in thinking mode |
| `seed` | none | `unsupported` |
| `max_output_tokens` | `max_tokens` | `exact`, subject to model context limits |
| `stop_sequences` | `stop` | `exact`; the current API accepts at most 16 sequences |
| `presence_penalty` | deprecated native field | `unsupported`; the current API ignores it |
| `frequency_penalty` | deprecated native field | `unsupported`; the current API ignores it |
| `stream` | `stream` | `exact`; `stream_options.include_usage` may be enabled by the adapter when usage evidence is required |
| `response_format: text` | `response_format.type: text` | `exact` |
| `response_format: json_object` | `response_format.type: json_object` | `qualified`; the prompt must also instruct the model to produce JSON |
| `response_format: json_schema` | none | `unsupported` |
| `return_logprobs` | `logprobs` | `exact` |
| `top_logprobs` | `top_logprobs` | `exact` from 0 through 20 and only when logprobs are enabled |
| `reasoning_mode` | `thinking.type` | `enabled` and `disabled` map exactly; `adaptive` is unsupported |
| `reasoning_effort` | `reasoning_effort` | Canonical `high` maps exactly; native `max` is an extension; `low` and `medium` are transformed to `high` and are not exact |
| `include_reasoning` | `reasoning_content` response field | `qualified`; thinking mode returns reasoning content and does not expose an independent include toggle |

DeepSeek thinking mode MUST reject a request that also supplies temperature,
top-p, presence penalty, or frequency penalty. The provider accepts those
fields but ignores them, which is precisely the silent omission prohibited by
section 4.

Tool declarations work in thinking and non-thinking modes. `tool_choice` maps
to the canonical vocabulary for non-thinking requests. DeepSeek's current V4
integration guidance states that thinking mode rejects `tool_choice`, so the
adapter MUST classify it by mode rather than assume generic OpenAI support.
`parallel_tool_calls` remains `unknown` until documented or probed.

For a thinking-mode tool sequence, the adapter MUST preserve and replay the
assistant `reasoning_content` in subsequent requests and MUST retain non-null
assistant content where the provider requires it. Failure to do so is a
protocol error, not a model correctness failure.

DeepSeek's beta strict function mode and `user_id` are provider extensions.
`user_id` MUST NOT contain private or direct personal identifiers. The returned
`system_fingerprint`, reasoning-token count, and cache-hit/cache-miss token
counts are evidence fields, not request parameters, and SHOULD be normalized
under the metrics contract.

Provider mappings MUST be maintained against primary provider documentation:

- [OpenAI Chat API reference](https://developers.openai.com/api/reference/resources/chat)
- [Ollama Modelfile parameters](https://docs.ollama.com/modelfile)
  and [OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)
- [Anthropic Messages API](https://platform.claude.com/docs/en/api/messages/create)
  and [extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)
- [Gemini GenerateContent API](https://ai.google.dev/api/generate-content)
- [Mistral Chat API](https://docs.mistral.ai/api)
  and [reasoning guide](https://docs.mistral.ai/studio-api/conversations/reasoning)
- [DeepSeek Chat API](https://api-docs.deepseek.com/api/create-chat-completion/)
  and [thinking-mode guide](https://api-docs.deepseek.com/guides/thinking_mode/)

Provider documentation is evidence for possible native support. Actual target
support still requires capability discovery, a maintained capability record, or
a conformance probe.

## 7. Unsupported Parameters and Comparability

`unsupported_parameter_policy` has two canonical values:

| Value | Behavior |
|---|---|
| `strict` | Reject preflight if any explicitly requested parameter is not `exact` or accepted as `qualified`. |
| `omit_with_warning` | Omit unsupported values, persist the omission, and mark the target ineligible for strict comparison. |

`strict` is the default and MUST be used for saved comparisons and ranking.
`omit_with_warning` is intended for exploratory runs only.

The current `permissive` value SHOULD be replaced by
`omit_with_warning`; new documents MUST NOT depend on the less explicit name.

A saved comparison MUST also declare one provider-default policy:

| Value | Behavior |
|---|---|
| `require_known_equal` | Every canonical parameter that can affect the template outcome is explicit or proven equal across targets. |
| `allow_target_defaults` | Unset values may use each target's defaults; evidence and reports identify the comparison as target-default based. |

`require_known_equal` is the default for controlled parameter comparisons.
`allow_target_defaults` supports the product decision “which model/server
combination is best as configured,” but MUST NOT be described as a comparison
under identical generation parameters.

A `qualified` mapping may proceed under `strict` only when:

- the qualification is visible before execution;
- the template does not require the missing semantic guarantee;
- every target in the comparison has an equivalent qualification, or the
  comparison rule explicitly accepts the difference.

Two results are parameter-comparable only when:

- their normalized requested parameter sets are equal;
- every requested parameter was applied with equivalent semantics;
- provider defaults satisfy the declared provider-default policy;
- response transport and reasoning-token accounting do not alter the measured
  contract;
- target-specific extensions are absent or explicitly accepted by the
  comparison definition.

Parameter incomparability MUST exclude a result from ranking, not merely add a
warning beside an otherwise ranked result.

## 8. Execution Parameters

Execution parameters affect reliability or measurement conditions, not model
sampling.

### 8.1 Request execution policy

| Canonical name | Type and allowed values | Required behavior |
|---|---|---|
| `request_timeout_ms` | integer, `>= 1` | Deadline for one provider request attempt. |
| `retry.max_retries` | integer, `>= 0` | Number of attempts after the first attempt. |
| `retry.retry_on` | unique error-code array | Exact normalized error categories eligible for retry. |
| `retry.backoff` | `none`, `fixed`, `linear`, or `exponential` | Retry delay algorithm. |
| `retry.base_delay_ms` | integer, `>= 0` | Base delay for the selected algorithm. |
| `retry.max_delay_ms` | integer, `>= 0` | Upper delay bound; MUST be at least the base delay. |
| `cancellation.cancel_on_first_fatal_error` | boolean | Cancels remaining work after a fatal error. |
| `cancellation.max_error_rate` | number, `0..1`, or unset | Cancels after the completed-sample error rate exceeds the threshold. |
| `cancellation.max_consecutive_errors` | integer, `>= 1`, or unset | Cancels after the threshold is reached. |
| `cancellation.graceful_shutdown` | boolean | Stops scheduling new work and allows active work to settle. |
| `cancellation.persist_partial_results` | boolean | Preserves completed observations and cancellation evidence. |

Retry error codes MUST use the normalized error taxonomy, including timeout,
connection failure, and explicitly listed HTTP status classes. A retry attempt
MUST retain its own timing, status, and error evidence. Metrics for a final
sample MUST not hide the cost or latency of prior failed attempts.

The current duplicate `timeout_ms` fields in inference parameters and execution
policy MUST converge on `execution_policy.request_timeout_ms`.

### 8.2 Stage controls

| Canonical name | Type and allowed values | Meaning |
|---|---|---|
| `iterations_per_item` | integer, `>= 1` | Number of measured repetitions for each dataset item. |
| `record_metrics` | boolean | Whether the stage emits metric observations. |
| `order` | `sequential` or `random` | Dataset item scheduling order. |
| `order_seed` | signed safe integer | Reproduces randomized item ordering; required when `order` is `random`. |
| `pre_iteration_delay_ms` | integer, `>= 0` | Delay before each iteration. |
| `cooldown_ms` | integer, `>= 0` | Delay after each iteration. |
| `intra_pair_delay_ms` | integer, `>= 0` | Delay between requests in a paired stage. |
| `stop_on_error` | boolean | Stops the current stage after its first error. |

The ordering seed is distinct from the model sampling `seed`.

Paired stages additionally own pair member identity, role, request reuse, and
derived-metric definitions. Those are stage structure, not provider request
parameters.

### 8.3 Plan orchestration

| Canonical name | Type and allowed values | Meaning |
|---|---|---|
| `mode` | `sequential` or `parallel` | Target execution mode. |
| `concurrency` | integer, `>= 1` | Maximum active provider requests for the plan. |
| `continue_on_target_error` | boolean | Continues remaining targets after one target fails. |
| `provider_default_policy` | `require_known_equal` or `allow_target_defaults` | Defines whether unset provider/model defaults may differ across targets. |

`continue_on_target_error` replaces the model-specific current name
`continue_on_model_error`, because one model/server pair is the comparison
target.

Sequential execution with `concurrency: 1` remains the default for functional
comparison. Parallel execution MUST require server capability support and MUST
mark performance results as contention-affected unless the template explicitly
defines a load or capacity test.

## 9. Target and Operation Parameters

### 9.1 Target selection

A resolved target MUST identify:

- `server_id`;
- `model_id`;
- protocol and operation;
- provider endpoint;
- model and server snapshot hashes or equivalent immutable snapshots.

Display names MUST NOT be used as stable identifiers.

### 9.2 Model target metadata

A model profile and snapshot MUST handle:

| Group | Parameters |
|---|---|
| Identity | provider, family, version, revision, checksum, and base-model identity |
| Architecture | format, precision, quantization method and variant |
| Capabilities | text generation, structured output, tools, embeddings, multimodal input/output, and explicit reasoning |
| Limits | context window, maximum output tokens, images, and batch size |
| Declared defaults | temperature, top-p, top-k, penalties, and seed when reported |
| Context strategy | strategy type and effective window |

Discovered or manually declared model defaults are target metadata. They MUST
NOT be copied silently into requested runtime parameters.

When a requested field is unset, a known target default SHOULD be recorded as a
`provider_default` resolution. An unknown default remains unknown and can affect
comparison eligibility as defined in section 7.

Context strategy and limits MUST be checked before execution. Truncation,
sliding-window behavior, summarization, or any other prompt transformation MUST
be explicit in the resolved evidence because it changes the model input.

### 9.3 Operation specification

The operation specification owns:

| Name | Meaning |
|---|---|
| `method` | HTTP method used by the operation. |
| `url` | Fully resolved request URL. |
| `endpoint` | Provider endpoint path or operation identifier. |
| `protocol` | Adapter contract such as `openai_chat`, `ollama_chat`, `anthropic_messages`, or `gemini_generate_content`. |
| `operation` | Canonical operation family. |
| `supports_streaming` | Verified operation-level streaming capability. |
| `supports_usage` | Verified operation-level usage reporting capability. |

These values are resolved by InferHarness from the selected server and adapter.
Users configure the server endpoint and capabilities; ordinary run forms SHOULD
not require users to edit the resolved operation URL or protocol payload.

### 9.4 Server registration

An inference-server record MUST handle:

| Group | Parameters |
|---|---|
| Identity | stable `server_id`, `display_name`, active/archive state |
| Endpoint | `base_url`, optional `health_url`, HTTPS state |
| API | one or more schema families and optional API version |
| Authentication | `type`, `header_name`, `token_env`, and secret-presence state |
| Capabilities | streaming, model discovery, generation operations, structured output, tools, multimodal input/output, reasoning, and concurrency |
| Discovery | retrieval time, time-to-live, and normalized model list |

Authentication types are `none`, `bearer`, `basic`, `oauth`, and `custom`.
`token_env` SHOULD be the normal secret reference. Plaintext tokens MUST NOT
appear in benchmark documents, model/server snapshots, logs, exports, or result
evidence.

The application MAY hold a token in process memory for request execution.
Persisted server responses MUST expose only whether a token is present.

### 9.5 Pricing metadata

Provider pricing is target metadata, not an inference parameter. A versioned
pricing snapshot used by the [cost metrics](METRICS.md#95-cost) MUST handle:

| Name | Meaning |
|---|---|
| `provider_id` | Stable provider identity |
| `billing_model_id` | Model identifier used by the provider for billing |
| `currency` | Pricing currency, normally `USD` for canonical cost metrics |
| `price_unit` | Token or request quantity to which each rate applies |
| `input_token_rate` | Standard input-token price |
| `cached_input_token_rate` | Cache-read input-token price when distinct |
| `cache_write_token_rate` | Cache-write input-token price when distinct |
| `output_token_rate` | Output-token price |
| `reasoning_token_rate` | Reasoning-token price when billed separately |
| `request_rate` | Per-request charge when applicable |
| `minimum_charge` | Minimum provider charge when applicable |
| `effective_from` / `effective_to` | Pricing validity interval |
| `source_url` | Authoritative pricing source |
| `retrieved_at` | Snapshot retrieval time |
| `pricing_version` | Immutable local snapshot version |

Unavailable or ambiguous pricing fields MUST remain unset. They MUST NOT be
treated as zero.

A planned round cost is an estimate computed from a benchmark plan, expected
item/iteration/attempt counts, an explicit token-volume assumption, and the
selected pricing snapshot. It MUST remain separate from measured run cost.
Local-server hardware, energy, and amortization estimates require a separate
declared local cost model and MUST NOT reuse provider token rates.

## 10. Application and Deployment Parameters

Application settings do not belong in runtime profiles. They are configured by
environment or by a dedicated application setting.

### 10.1 Environment contract

| Group | Name | Default or requirement | Scope |
|---|---|---|---|
| API auth | `INFERHARNESS_API_TOKEN` | Required or locally generated | Backend shared API token; secret |
| API auth | `VITE_INFERHARNESS_API_TOKEN` | Paired with backend token | Frontend build/runtime token; secret |
| HTTP | `PORT` | `8080` | Backend listening port |
| HTTP | `VITE_INFERHARNESS_API_BASE_URL` | `http://localhost:8080` | Browser API base URL |
| HTTP | `VITE_INFERHARNESS_FRONTEND_BASE_URL` | `http://localhost:5173` | Frontend base URL |
| Storage | `INFERHARNESS_DB_PATH` | Repository-local SQLite path | Database location |
| Storage | `INFERHARNESS_BENCHMARK_LIBRARY_ROOT` | Repository-local document library | Writable benchmark document root |
| Storage | `INFERHARNESS_BENCHMARK_LIBRARY_AUTOSEED` | Enabled outside tests | Startup library import |
| Storage | `INFERHARNESS_BENCHMARK_DATASET_ROOT` | Unset | Server-side dataset root |
| Retention | `RETENTION_DAYS` | `30` | Result retention period |
| Discovery | `INFERHARNESS_HEALTH_POLL_INTERVAL` | `30` seconds | Server health polling |
| Discovery | `INFERHARNESS_CONTEXT_PROBE_TIMEOUT_MS` | `300000` ms | Context discovery/probe deadline |
| Discovery | `CONNECTIVITY_TIMEOUT_MS` | `5000` ms | Connectivity probe deadline |
| Connectivity | `INFERHARNESS_INFERENCE_PROXY` | Unset | Outbound inference HTTP proxy |
| Connectivity | `INFERHARNESS_INFERENCE_NO_PROXY` | `localhost,127.0.0.1` | Proxy bypass list |
| Connectivity | `INFERHARNESS_INFERENCE_TLS_INSECURE` | `false` | Disables outbound TLS verification |
| Protocol data | `INFERHARNESS_PROXY_PERPLEXITY_DATASET` | Unset | Proxy perplexity dataset path |
| Python | `INFERHARNESS_PYTHON_BIN` | `python3` | Python subprocess executable |
| Provider auth | `HF_TOKEN` or `HUGGINGFACE_HUB_TOKEN` | Unset | Gated Hugging Face access; secret |

Names, accepted forms, defaults, units, and security classification MUST be
identical in Settings, `.env.example`, the root README, and runtime validation.

Boolean environment values MUST use documented case-insensitive `true`/`false`
forms unless an existing variable explicitly defines `1`/`0`. Numeric values
MUST be finite integers within their valid domain. Invalid environment values
MUST fail startup or be rejected by Settings; they MUST NOT silently become
`NaN`, zero, or an unrelated default.

`INFERHARNESS_INFERENCE_TLS_INSECURE=true` is a security-sensitive override. The
application MUST display and log a non-secret warning while it is active.

### 10.2 Persisted app settings

The current persisted application setting is:

| Name | Shape | Requirement |
|---|---|---|
| `template_agent_model` | `{ server_id, model_id }` or unset | Must reference an active, non-archived model |

Future app settings MUST have one canonical owner. A value MUST NOT be editable
both as a database setting and an environment variable unless explicit
precedence is documented.

### 10.3 Internal inference consumers

Application-owned model calls, including the benchmark-template authoring
agent, MUST use the same canonical parameter validation and provider mapping as
benchmark execution.

Their values MAY come from a versioned system profile rather than a
user-selected benchmark runtime profile. The system profile MUST still make its
temperature, output limit, response format, stream mode, timeout, and other
requested values explicit. Internal consumers MUST NOT maintain separate
provider-native payload builders with hidden parameter defaults.

Internal calls are not benchmark evidence unless a benchmark explicitly
measures them, but their parameters and errors SHOULD remain operationally
auditable.

### 10.4 Evidence impact

Environment values that can affect benchmark interpretation SHOULD be captured
as sanitized execution context. Examples include proxy use, TLS verification
mode, controller version, and measurement locality.

Paths, tokens, headers, and other secrets or machine-sensitive values MUST be
redacted or represented by a safe classification rather than copied verbatim.

## 11. Persistence and Audit Contract

Each immutable test instantiation or result MUST preserve:

- canonical contract version;
- requested canonical parameters;
- resolved canonical parameters;
- parameter source for every resolved value;
- selected unsupported-parameter policy;
- support state and qualification for every requested parameter;
- adapter and protocol version;
- sanitized provider-native parameter mapping;
- omitted parameters and reasons;
- provider defaults, when known, with provenance;
- execution policy and stage/plan controls;
- model and server snapshots;
- parameter comparability decision and reasons.

A parameter resolution entry SHOULD have this logical shape:

```json
{
  "name": "max_output_tokens",
  "source": "runtime_profile",
  "requested": 2048,
  "support": "exact",
  "native_path": "generationConfig.maxOutputTokens",
  "applied": 2048,
  "status": "applied",
  "qualification": null
}
```

Allowed resolution statuses are `applied`, `transformed`, `omitted`,
`provider_default`, and `rejected`.

Raw provider request evidence MUST be sanitized before persistence. Secret
headers, bearer tokens, API keys, credentials in URLs, and secret provider
extensions MUST never be stored.

## 12. UI and API Requirements

The UI, API, schema validator, and provider adapter MUST use the same canonical
names and constraints.

The UI MUST:

- show explicit preset values before execution;
- distinguish unset from zero and false;
- filter or annotate controls using target capability information;
- show provider qualifications and omissions before a comparison starts;
- prevent invalid combinations;
- show units for time, token, and concurrency controls;
- keep advanced provider extensions visibly separate from portable parameters.

The API MUST:

- reject unknown canonical fields;
- reject invalid types, ranges, and combinations;
- reject ownership violations and conflicting sources;
- return machine-readable parameter error paths and codes;
- perform the same validation for UI, import, and future headless execution;
- produce the same resolved instantiation for equivalent inputs.

Capability-based hiding in the UI is not validation. The backend remains
responsible for authoritative validation and preflight.

## 13. Current Implementation Gap

The current codebase provides useful foundations but does not yet conform fully
to this contract:

| Area | Current behavior | Required convergence |
|---|---|---|
| Presets | Expose temperature, top-p, max tokens, stream, and legacy quantization | Use the complete canonical runtime parameter object and strict validation |
| Naming | Uses `max_tokens`, `stop`, and duplicate `timeout_ms` | Adopt `max_output_tokens`, `stop_sequences`, and `request_timeout_ms` |
| Validation | Preset numbers are checked mainly for finiteness | Enforce canonical types, ranges, integers, combinations, and target limits |
| Provider mapping | Core fields map to four chat protocols; Mistral and DeepSeek currently pass through the generic OpenAI adapter | Add capability-aware mappings, provider profiles, qualifications, and resolution evidence |
| OpenAI-compatible deviations | Generic `seed` is wrong for Mistral; DeepSeek ignores penalties and thinking-mode sampling fields | Apply explicit Mistral and DeepSeek adapter profiles before declaring parameter support |
| Unsupported values | Some provider adapters silently omit unsupported fields | Enforce `strict` or explicit `omit_with_warning` |
| Defaults | Anthropic requests receive an implicit `max_tokens: 1024` | Require an explicit visible value |
| Runtime schema | Inference config and runtime profile duplicate fields; instantiation parameters are loose | Define one reusable schema and embed or bundle it consistently |
| Tool choice | Item value currently takes precedence over runtime value | Make item ownership explicit and reject conflicting non-item sources |
| Reasoning/output | Capability metadata exists but runtime controls are incomplete | Add canonical controls only with complete adapter and evidence support |
| Comparability | No complete parameter-equivalence decision | Persist eligibility and exclude incomparable results from ranking |
| Execution | Retry/cancellation schemas and runner foundations exist | Align names, UI, persistence, and observable behavior |
| Concurrency | Plan schema contains parallel mode; Run currently emits concurrency 1 | Keep sequential default and add controlled Milestone 3 behavior |
| Internal inference | Template-agent requests use separate hard-coded OpenAI/Ollama payloads | Use a versioned system profile and the canonical adapter path |
| Pricing | Metrics define cost evidence but no canonical pricing parameter record exists | Add versioned provider pricing snapshots outside runtime profiles |

This section describes migration work, not compatibility promises. Durable
schemas and runtime copies should move together when this foundation is
implemented.

## 14. Change Control

The canonical contract begins as `parameters-v1` when its schemas and runtime
implementation are introduced.

Adding an optional parameter with unchanged existing semantics is a compatible
minor contract change. Renaming a parameter, changing its meaning, unit, range,
default behavior, precedence, provider mapping, or comparison effect is a
breaking contract change.

Every parameter change MUST update, in the same implementation change:

- this document;
- canonical schemas under `docs/schemas/`;
- synchronized runtime schema copies;
- frontend and backend types and validation;
- provider mapping tests for supported and unsupported targets;
- persistence and redaction tests;
- comparison eligibility tests;
- relevant README and changelog text.

Provider API drift MAY update a mapping qualification without changing the
canonical parameter when the canonical semantics remain stable. Such changes
still require evidence, tests, and documentation.

## 15. Acceptance Criteria

This specification is implemented when:

1. One reusable canonical schema defines all chat-completion inference
   parameters.
2. UI presets, runtime profiles, instantiations, APIs, and adapters consume that
   contract from their runtime source copies.
3. Every valid parameter has positive, boundary, invalid, unsupported, and
   provider-mapping tests where applicable.
4. No explicitly requested value is silently clamped, defaulted, transformed,
   or omitted.
5. Every completed result records requested and applied parameter evidence
   without secrets.
6. Parameter comparability is evaluated before ranking.
7. Equivalent UI, API, import, and future headless inputs resolve identically.
8. Application environment settings are validated consistently and remain
   separate from reproducible runtime profiles.
