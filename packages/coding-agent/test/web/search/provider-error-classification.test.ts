import { describe, expect, it } from "bun:test";
import { formatSearchProviderFailure } from "@oh-my-pi/pi-coding-agent/web/search/provider";
import { classifyProviderHttpError } from "@oh-my-pi/pi-coding-agent/web/search/providers/utils";

// Phrase-level quota detection lives in pi-ai's isAccountQuotaExhaustedText
// (packages/ai/test/rate-limit-utils.test.ts). These tests cover only the
// wrapper contract: delegation, status fallbacks, and formatted output.
describe("classifyProviderHttpError credit-signal coverage", () => {
	it("delegates quota-exhaustion bodies to the shared classifier", () => {
		const error = classifyProviderHttpError("xai", 429, "quota exceeded");
		expect(error).not.toBeNull();
		expect(error?.message).toContain("credits exhausted");
		expect(error?.status).toBe(429);
		// Non-quota bodies fall through to the caller's raw error.
		expect(classifyProviderHttpError("xai", 500, "internal error")).toBeNull();
	});

	it("keeps the credits diagnosis when formatting auth-status billing failures", () => {
		// 403 bodies classified as billing exhaustion must not be rewritten to
		// the generic "authorization failed" summary: the user-facing fallback
		// message would misdiagnose a billing failure as a bad API key.
		const error = classifyProviderHttpError("brave", 403, "billing account suspended");
		expect(error).not.toBeNull();
		expect(formatSearchProviderFailure(error!, { id: "brave", label: "Brave" })).toContain("credits exhausted");
	});

	it("still maps bare 402/401/403 statuses when the body is silent", () => {
		expect(classifyProviderHttpError("xai", 402, "")?.message).toContain("credits exhausted");
		expect(classifyProviderHttpError("xai", 401, "")?.message).toContain("401 unauthorized");
		expect(classifyProviderHttpError("xai", 403, "")?.message).toContain("403 forbidden");
	});
});
