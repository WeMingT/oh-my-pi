import { describe, expect, it } from "bun:test";
import { formatSearchProviderFailure } from "@oh-my-pi/pi-coding-agent/web/search/provider";
import { classifyProviderHttpError } from "@oh-my-pi/pi-coding-agent/web/search/providers/utils";

describe("classifyProviderHttpError credit-signal coverage", () => {
	it.each([
		["insufficient_quota", 429],
		["credits_exhausted", 402],
		["Your balance is insufficient", 400],
		["billing account suspended", 400],
		["Your credit balance has been exhausted", 400],
		["billing is overdue", 400],
		["账户额度已用尽", 429],
		["Your subscription has reached its rate limit", 429],
		["monthly plan cap exceeded", 429],
	])("maps %s (%d) to a credits-exhausted error", (body, status) => {
		const error = classifyProviderHttpError("xai", status, body);
		expect(error).not.toBeNull();
		expect(error?.message).toContain("credits exhausted");
		expect(error?.status).toBe(status);
	});

	it("does not misread unrelated bodies as credit failures", () => {
		expect(classifyProviderHttpError("xai", 400, "invalid model id")).toBeNull();
		expect(classifyProviderHttpError("xai", 400, "billing address is required")).toBeNull();
		expect(classifyProviderHttpError("xai", 400, "invalid billing configuration")).toBeNull();
		expect(classifyProviderHttpError("xai", 400, "balance field must be a number")).toBeNull();
		expect(classifyProviderHttpError("xai", 400, "余额字段格式错误")).toBeNull();
		expect(classifyProviderHttpError("xai", 400, "额度上限说明见文档")).toBeNull();
		expect(classifyProviderHttpError("xai", 500, "internal error")).toBeNull();
		expect(classifyProviderHttpError("xai", 429, "rate limited, retry later")).toBeNull();
		expect(classifyProviderHttpError("xai", 500, "load balancer request exceeded timeout")).toBeNull();
		expect(classifyProviderHttpError("xai", 500, "billing webhook exceeded its retry deadline")).toBeNull();
		expect(classifyProviderHttpError("xai", 400, "balance exceededness is not a valid field")).toBeNull();
	});

	it("stays linear on bodies stuffed with repeated billing tokens", () => {
		// Repeated prefixes formerly retried the rest of the body at each
		// position. A generous ceiling detects that multi-second stall.
		const adversarial = "billing ".repeat(10 * 1024);
		const started = performance.now();
		expect(classifyProviderHttpError("xai", 400, adversarial)).toBeNull();
		expect(performance.now() - started).toBeLessThan(1000);
	});

	it("maps Chinese quota-exhaustion bodies via the shared classifier", () => {
		// 429 has no bare-status fallback, so a 配额已耗尽 body must be
		// recognized through matchesUsageLimitText (pi-ai) — previously it
		// fell through to the raw provider error.
		expect(classifyProviderHttpError("xai", 429, "配额已耗尽")?.message).toContain("credits exhausted");
		expect(classifyProviderHttpError("xai", 429, "额度已用完")?.message).toContain("credits exhausted");
		// Transient CN caps (rate/frequency ceilings) are not quota exhaustion.
		expect(classifyProviderHttpError("xai", 429, "速率达到上限，请稍后重试")).toBeNull();
	});

	it("does not relabel transient resource-exhausted failures as credits", () => {
		// pi-ai deliberately classifies bare resource_exhausted (space and
		// Connect underscore forms) as transient MODEL_CAPACITY with its own
		// backoff (regression #7032); the flag-level usage-limit matcher also
		// matches it, so classification here must use the reason level.
		expect(classifyProviderHttpError("xai", 429, "resource_exhausted")).toBeNull();
		expect(classifyProviderHttpError("xai", 429, "Connect error resource_exhausted: Error")).toBeNull();
		expect(classifyProviderHttpError("xai", 429, "resource exhausted")).toBeNull();
	});

	it("does not relabel unrelated exhaustion phrases as credits", () => {
		// parseRateLimitReason's generic branch matches every "exhausted"
		// occurrence, which suits chat-retry text but mislabels infrastructure
		// failures on raw provider bodies; only account-quota wording (backed
		// by quota/credits/spend/limit tokens) may map to credits exhausted.
		expect(classifyProviderHttpError("firecrawl", 500, "retry attempts exhausted")).toBeNull();
		expect(classifyProviderHttpError("brave", 500, "connection pool exhausted")).toBeNull();
		expect(classifyProviderHttpError("kagi", 500, "timeout budget exhausted")).toBeNull();
		// Quota-backed exhaustion still maps.
		expect(classifyProviderHttpError("xai", 429, "quota exceeded")?.message).toContain("credits exhausted");
		expect(classifyProviderHttpError("xai", 429, "usage limit reached")?.message).toContain("credits exhausted");
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
