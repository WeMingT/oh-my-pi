import { describe, expect, it } from "bun:test";
import { classifyProviderHttpError } from "@oh-my-pi/pi-coding-agent/web/search/providers/utils";

describe("classifyProviderHttpError credit-signal coverage", () => {
	it.each([
		["insufficient_quota", 429],
		["credits_exhausted", 402],
		["Your balance is insufficient", 402],
		["billing account suspended", 403],
		["Your credit balance has been exhausted", 402],
		["billing is overdue", 403],
		["账户额度已用尽", 429],
		["余额不足，请充值", 400],
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
	});

	it("stays linear on bodies stuffed with repeated billing tokens", () => {
		// An unanchored scan retries the gap from every `billing ` match
		// position; with an unbounded gap that is quadratic (~seconds on an
		// 80 KB error page). The bounded {0,40} gap keeps it linear. The
		// assertion is the null result; the runtime bound is the contract.
		const adversarial = "billing ".repeat(10 * 1024);
		expect(classifyProviderHttpError("xai", 400, adversarial)).toBeNull();
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

	it("still maps bare 402/401/403 statuses when the body is silent", () => {
		expect(classifyProviderHttpError("xai", 402, "")?.message).toContain("credits exhausted");
		expect(classifyProviderHttpError("xai", 401, "")?.message).toContain("401 unauthorized");
		expect(classifyProviderHttpError("xai", 403, "")?.message).toContain("403 forbidden");
	});
});
