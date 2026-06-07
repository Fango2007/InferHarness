import {
  Agent,
  EnvHttpProxyAgent,
  fetch as undiciFetch,
  setGlobalDispatcher,
  type Dispatcher
} from 'undici';

export const INFERENCE_PROXY_ENV = 'INFERHARNESS_INFERENCE_PROXY';
export const INFERENCE_NO_PROXY_ENV = 'INFERHARNESS_INFERENCE_NO_PROXY';
export const INFERENCE_TLS_INSECURE_ENV = 'INFERHARNESS_INFERENCE_TLS_INSECURE';

export interface InferenceProxyConfig {
  proxy: string;
  noProxy?: string;
}

let backendFetchDispatcher: Dispatcher | null = null;
type UndiciFetchInput = Parameters<typeof undiciFetch>[0];
type UndiciFetchInit = Parameters<typeof undiciFetch>[1];

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export function resolveInferenceProxyConfig(
  env: NodeJS.ProcessEnv = process.env
): InferenceProxyConfig | null {
  const proxy = env[INFERENCE_PROXY_ENV]?.trim();
  if (!proxy) {
    return null;
  }

  const noProxy = env[INFERENCE_NO_PROXY_ENV]?.trim();
  return noProxy ? { proxy, noProxy } : { proxy };
}

export function shouldDisableInferenceTlsVerification(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthyEnv(env[INFERENCE_TLS_INSECURE_ENV]);
}

export function configureInferenceProxyFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const config = resolveInferenceProxyConfig(env);
  const tlsInsecure = shouldDisableInferenceTlsVerification(env);
  const requestTls = tlsInsecure ? { rejectUnauthorized: false } : undefined;

  if (config) {
    backendFetchDispatcher = new EnvHttpProxyAgent({
      httpProxy: config.proxy,
      httpsProxy: config.proxy,
      noProxy: config.noProxy ?? '',
      proxyTunnel: false,
      ...(requestTls ? { requestTls, proxyTls: requestTls } : {})
    });
  } else if (requestTls) {
    backendFetchDispatcher = new Agent({
      connect: requestTls
    });
  } else {
    return false;
  }

  setGlobalDispatcher(backendFetchDispatcher);
  globalThis.fetch = backendFetch as typeof globalThis.fetch;

  return true;
}

export function backendFetch(input: UndiciFetchInput, init?: UndiciFetchInit): ReturnType<typeof undiciFetch> {
  if (!backendFetchDispatcher) {
    return globalThis.fetch(
      input as Parameters<typeof globalThis.fetch>[0],
      init as Parameters<typeof globalThis.fetch>[1]
    ) as ReturnType<typeof undiciFetch>;
  }

  return undiciFetch(input, {
    ...(init ?? {}),
    dispatcher: backendFetchDispatcher
  });
}
