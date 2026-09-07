import type { TranslationRequest } from "../../domain/translation";
import {
  ConfigurationError,
  EscalationRequiredError,
  PermanentUpstreamError,
} from "../../shared/errors";
import type { TranslationProvider, ProviderTranslationCandidate } from "../translation/provider";
import { callDeepLTranslate, type DeepLClientOptions } from "./client";
import { selectDeepLRoute } from "./gate";

function invalidResponse(): never {
  throw new PermanentUpstreamError("Invalid DeepL translation", "deepl", {
    stage: "logical-validation",
  });
}

export interface DeepLTranslationProviderOptions extends Omit<DeepLClientOptions, "apiKey"> {
  readonly apiKey?: string | undefined;
}

export class DeepLTranslationProvider implements TranslationProvider {
  constructor(private readonly options: DeepLTranslationProviderOptions) {}

  async translate(request: TranslationRequest): Promise<ProviderTranslationCandidate> {
    const route = selectDeepLRoute(request);
    if (route.provider !== "deepl") throw new EscalationRequiredError(route.reason);
    const apiKey = this.options.apiKey;
    if (apiKey === undefined || apiKey.trim() === "") {
      throw new ConfigurationError(
        "DeepL routine translation is selected but DEEPL_API_KEY is not registered",
      );
    }
    const payload = await callDeepLTranslate(request.sourceText, route.targetLanguage, {
      apiKey,
      ...(this.options.fetchFn !== undefined ? { fetchFn: this.options.fetchFn } : {}),
    });
    if (
      typeof payload !== "object" ||
      payload === null ||
      !("translations" in payload) ||
      !Array.isArray(payload.translations) ||
      payload.translations.length !== 1
    )
      invalidResponse();
    const translation: unknown = payload.translations[0];
    if (
      typeof translation !== "object" ||
      translation === null ||
      !("text" in translation) ||
      typeof translation.text !== "string" ||
      translation.text.trim() === "" ||
      translation.text.length > 4096 ||
      !("detected_source_language" in translation) ||
      typeof translation.detected_source_language !== "string" ||
      !/^[A-Z]{2,3}(?:-[A-Z]{2,4})?$/.test(translation.detected_source_language)
    )
      invalidResponse();
    const source = translation.detected_source_language;
    if (route.targetLanguage === "PT-BR" && source !== "JA") invalidResponse();
    return {
      needsEscalation: false,
      escalationReason: "none",
      outcome:
        route.targetLanguage === "JA" && source !== "PT"
          ? { kind: "skipped", detectedLanguage: "other", reason: "untargeted-language" }
          : {
              kind: "translated",
              detectedLanguage: route.targetLanguage === "JA" ? "pt-br" : "ja",
              targetLanguage: route.targetLanguage === "JA" ? "ja" : "pt-br",
              translatedText: translation.text,
            },
    };
  }
}

export function createDeepLTranslationProvider(
  options: DeepLTranslationProviderOptions,
): TranslationProvider {
  return new DeepLTranslationProvider(options);
}
