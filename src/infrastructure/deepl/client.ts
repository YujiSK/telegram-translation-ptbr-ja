import { PermanentUpstreamError, TransientUpstreamError } from "../../shared/errors";

export const DEEPL_TIMEOUT_MS = 5_000;
export interface DeepLClientOptions {
  readonly apiKey: string;
  readonly fetchFn?: typeof fetch;
}

/** One attempt, no redirects (credentials must stay on the fixed API host). */
export async function callDeepLTranslate(
  text: string,
  targetLanguage: "PT-BR" | "JA",
  options: DeepLClientOptions,
): Promise<unknown> {
  const host = options.apiKey.endsWith(":fx") ? "api-free.deepl.com" : "api.deepl.com";
  const signal = AbortSignal.timeout(DEEPL_TIMEOUT_MS);
  let response: Response;
  try {
    response = await (options.fetchFn ?? fetch)(`https://${host}/v2/translate`, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        Authorization: `DeepL-Auth-Key ${options.apiKey}`,
      },
      body: JSON.stringify({
        text: [text],
        target_lang: targetLanguage,
        ...(targetLanguage === "PT-BR" ? { source_lang: "JA" } : {}),
      }),
      signal,
    });
  } catch (error) {
    const networkErrorKind =
      error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")
        ? "abort"
        : error instanceof TypeError
          ? "type-error"
          : "other";
    throw new TransientUpstreamError("DeepL request failed", "deepl", {
      stage: "request",
      networkErrorKind,
    });
  }
  if (!response.ok) {
    const ErrorType =
      response.status === 408 || response.status === 429 || response.status >= 500
        ? TransientUpstreamError
        : PermanentUpstreamError;
    throw new ErrorType("DeepL HTTP failure", "deepl", {
      stage: "http",
      httpStatus: response.status,
    });
  }
  try {
    return await response.json();
  } catch (error) {
    if (
      signal.aborted ||
      (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
    ) {
      throw new TransientUpstreamError("DeepL response timed out", "deepl", {
        stage: "response-envelope",
      });
    }
    throw new PermanentUpstreamError("Invalid DeepL response", "deepl", {
      stage: "response-envelope",
    });
  }
}
