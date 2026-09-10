import { isRecord, tryParseJson } from "@oh-my-pi/pi-utils";
import type { AgentStorage } from "../../../session/agent-storage";
import {
	DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS,
	SearchProviderError,
	type SearchProviderId,
	type SearchSource,
} from "../../../web/search/types";
import { dateToAgeSeconds } from "../utils";

/**
 * Search for an API credential by checking an env-derived key first,
 * then falling back to agent.db stored credentials for the given providers.
 *
 * The caller MUST supply an open {@link AgentStorage} handle so the helper
 * never reaches out to global filesystem state; both the unified web_search
 * chain and one-shot CLI calls open storage exactly once and thread it
 * through every provider.
 *
 * @param storage - Open agent storage handle
 * @param envKey - Pre-resolved environment variable value (or null)
 * @param storageProviders - Provider names to look up in AgentStorage
 */
export function findCredential(
	storage: AgentStorage | null | undefined,
	envKey: string | null | undefined,
	...storageProviders: string[]
): string | null {
	if (envKey) return envKey;
	if (!storage) return null;

	try {
		for (const provider of storageProviders) {
			const records = storage.listAuthCredentials(provider);
			for (const record of records) {
				const credential = record.credential;
				if (credential.type === "api_key" && credential.key.trim().length > 0) {
					return credential.key;
				}
				if (credential.type === "oauth" && credential.access.trim().length > 0) {
					return credential.access;
				}
			}
		}
	} catch {
		return null;
	}

	return null;
}

/**
 * The 60-second default tolerates legitimate slow LLM-mediated responses
 * (Anthropic web_search_20250305, Perplexity, Gemini, Codex) while bounding
 * Windows stalls when Bun's `AbortSignal` fails to propagate. Callers may
 * configure a longer provider deadline, capped at five minutes by the
 * dispatcher; pure search APIs typically settle far faster.
 */
export const SEARCH_HARD_TIMEOUT_MS = DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS * 1_000;

/**
 * Compose a caller-supplied {@link AbortSignal} with a hard timeout so an
 * outbound `fetch()` is guaranteed to settle within `ms` even when the
 * runtime fails to propagate cancellation to the underlying transport.
 *
 * Bun's WinHTTP backend on Windows is known to ignore `AbortSignal` once a
 * TCP/TLS connection stalls (oven-sh/bun#15275, oven-sh/bun#18536); without
 * this safety net a stalled web-search request freezes the entire session
 * because the user's Esc is never delivered to the native layer.
 *
 * @param signal - Caller cancellation signal, if any.
 * @param ms - Hard timeout in milliseconds. Defaults to {@link SEARCH_HARD_TIMEOUT_MS}.
 */
export function withHardTimeout(signal: AbortSignal | undefined, ms: number = SEARCH_HARD_TIMEOUT_MS): AbortSignal {
	const timeout = AbortSignal.timeout(ms);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Map a provider's raw source list to the unified SearchSource shape,
 * clamped to the requested result count and annotated with ageSeconds.
 */
export function toSearchSources(
	sources: ReadonlyArray<{
		title: string;
		url: string;
		snippet?: string;
		publishedDate?: string;
	}>,
	numResults: number,
): SearchSource[] {
	return sources.slice(0, numResults).map(source => ({
		title: source.title,
		url: source.url,
		snippet: source.snippet,
		publishedDate: source.publishedDate,
		ageSeconds: dateToAgeSeconds(source.publishedDate),
	}));
}

// Explicit credit-exhaustion arm of the legacy heuristic: unambiguous wording
// that keeps its billing diagnosis on every status.
const EXPLICIT_CREDIT_PATTERN = /credits?\s*(?:exhausted|exceeded)/i;
// Ambiguous arms of the legacy heuristic (`quota`, `insufficient`): valid
// billing signals on non-auth statuses, but on 401/403 they usually describe
// authorization problems ("insufficient authentication scope") and must not
// produce the billing diagnosis (see classifyProviderHttpError).
const AMBIGUOUS_CREDIT_PATTERN = /quota|insufficient/i;
// Whole messages from the original billing examples, not a natural-language grammar.
const BILLING_MESSAGE_PATTERN =
	/^\s*(?:your credit balance has been exhausted|billing account suspended|billing is overdue|(?:账户)?额度已用尽|余额不足(?:，请充值)?)[.!。！]?\s*$/i;

// Whether the body carries one of the exact billing aliases, either as the
// whole plain-text message or inside a JSON error envelope.
function hasBillingAliasMessage(body: string): boolean {
	if (BILLING_MESSAGE_PATTERN.test(body)) return true;
	const parsed = tryParseJson(body);
	if (!isRecord(parsed)) return false;
	// Envelopes can carry an unrelated `error` alongside a recognized
	// top-level `message`; test every candidate field instead of letting a
	// present `error` shadow it.
	const errorField = parsed.error;
	const candidates: Array<unknown> = [
		typeof errorField === "string" ? errorField : undefined,
		isRecord(errorField) ? errorField.message : undefined,
		parsed.message,
	];
	return candidates.some(candidate => typeof candidate === "string" && BILLING_MESSAGE_PATTERN.test(candidate));
}

/**
 * Quota/auth signals across providers. Telemetry on 15.1.7/15.1.8 showed users
 * hitting credit-exhaustion and 401/402/403 responses that were surfaced as
 * raw HTTP error text. Map those into compact, provider-tagged messages so
 * the orchestrator can chain-advance cleanly and the final summary stays
 * legible when every provider rejects the request.
 *
 * Returns `null` when the response does not match a known quota/auth signal,
 * leaving the caller to throw its provider-specific fallback error.
 */

export function classifyProviderHttpError(
	provider: SearchProviderId,
	status: number,
	body: string,
): SearchProviderError | null {
	// Exact billing aliases and the explicit credit arm diagnose a billing
	// failure on any status. The ambiguous arms are excluded on 401/403: auth
	// bodies like "insufficient authentication scope" would otherwise be
	// exposed as a billing failure instead of an authorization failure.
	if (
		hasBillingAliasMessage(body) ||
		EXPLICIT_CREDIT_PATTERN.test(body) ||
		(AMBIGUOUS_CREDIT_PATTERN.test(body) && status !== 401 && status !== 403)
	) {
		return new SearchProviderError(provider, `${provider}: credits exhausted`, status);
	}
	if (status === 402) {
		return new SearchProviderError(provider, `${provider}: 402 credits exhausted`, status);
	}
	if (status === 401) {
		return new SearchProviderError(provider, `${provider}: 401 unauthorized`, status);
	}
	if (status === 403) {
		return new SearchProviderError(provider, `${provider}: 403 forbidden`, status);
	}
	return null;
}
