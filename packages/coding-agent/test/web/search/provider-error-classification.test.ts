import { describe, expect, it } from "bun:test";
import { formatSearchProviderFailure } from "@oh-my-pi/pi-coding-agent/web/search/provider";
import { classifyProviderHttpError } from "@oh-my-pi/pi-coding-agent/web/search/providers/utils";

describe("classifyProviderHttpError", () => {
	it("preserves established English quota diagnostics", () => {
		const error = classifyProviderHttpError("xai", 429, "insufficient_quota");
		expect(error?.message).toContain("credits exhausted");
		expect(classifyProviderHttpError("xai", 500, "internal error")).toBeNull();
	});

	it.each([
		["English balance", "Insufficient balance"],
		["billing arrears", "billing is overdue"],
		["Chinese account allowance", "账户额度已用尽"],
		["Chinese balance", "余额不足，请充值"],
	])("recognizes the original %s diagnostic without a status fallback", (_kind, body) => {
		expect(classifyProviderHttpError("xai", 400, body)?.message).toContain("credits exhausted");
	});

	it.each([
		["error.message", JSON.stringify({ error: { message: "billing account suspended" } })],
		["error string", JSON.stringify({ error: "billing account suspended" })],
		["top-level message", JSON.stringify({ message: "billing account suspended" })],
		[
			"error object with top-level message",
			JSON.stringify({ error: { code: "billing_suspended" }, message: "billing account suspended" }),
		],
		["error string with top-level message", JSON.stringify({ error: "Bad Request", message: "billing is overdue" })],
		["escaped error.message", '{"error":{"message":"\\u4f59\\u989d\\u4e0d\\u8db3\\uff0c\\u8bf7\\u5145\\u503c"}}'],
	])("recognizes a known diagnostic in %s", (_field, body) => {
		expect(classifyProviderHttpError("xai", 400, body)?.message).toContain("credits exhausted");
	});

	it.each([
		[
			"unrelated JSON metadata",
			JSON.stringify({ error: { message: "invalid model id" }, debug: "billing account suspended" }),
		],
		["unrecognized prose", "invalid model id (previous error: billing account suspended)"],
		["malformed JSON", '{"error":{"message":"billing account suspended"'],
	])("does not infer a new billing failure from %s", (_kind, body) => {
		expect(classifyProviderHttpError("xai", 400, body)).toBeNull();
	});

	it("preserves billing diagnostics instead of formatting an authorization failure", () => {
		const body = JSON.stringify({ error: { message: "billing account suspended" } });
		for (const status of [401, 403]) {
			const error = classifyProviderHttpError("xai", status, body);
			expect(formatSearchProviderFailure(error, { id: "xai", label: "xAI" })).toContain("credits exhausted");
		}
	});

	it("keeps authorization summaries for broad insufficient wording on auth statuses", () => {
		// The legacy broad heuristic matches auth wording such as "insufficient
		// authentication scope"; on 401/403 that must stay an authorization
		// failure instead of being exposed as a billing diagnosis.
		const body = JSON.stringify({ error: { message: "insufficient authentication scope" } });
		expect(classifyProviderHttpError("xai", 403, body)?.message).toContain("403 forbidden");
		expect(classifyProviderHttpError("xai", 401, body)?.message).toContain("401 unauthorized");
		const error = classifyProviderHttpError("xai", 403, body);
		expect(formatSearchProviderFailure(error!, { id: "xai", label: "xAI" })).toContain("authorization failed");
	});

	it("preserves explicit credit-exhaustion matches on auth statuses", () => {
		expect(classifyProviderHttpError("xai", 403, "Insufficient balance")?.message).toContain("credits exhausted");
		// The auth-status exclusion exists to stop ambiguous wording such as
		// "insufficient authentication scope" from becoming a billing failure;
		// unambiguous credit arms of the legacy heuristic keep their billing
		// diagnosis on 401/403 (the pre-PR behavior).
		for (const body of ["credits exhausted", "credit exceeded"]) {
			for (const status of [401, 403]) {
				const error = classifyProviderHttpError("xai", status, body);
				expect(error?.message).toContain("credits exhausted");
			}
		}
		// A leading negation keeps the explicit arm ambiguous on auth statuses.
		expect(classifyProviderHttpError("xai", 403, "No credits exhausted; access was denied")?.message).toContain(
			"403 forbidden",
		);
	});

	it("preserves structured insufficient_quota codes on auth statuses", () => {
		// The code is an explicit quota signal even when the envelope message
		// is generic; the auth-status exclusion only gates ambiguous wording.
		const body = JSON.stringify({ error: { code: "insufficient_quota" }, message: "Generic provider failure" });
		for (const status of [401, 403]) {
			const error = classifyProviderHttpError("xai", status, body);
			expect(error?.message).toContain("credits exhausted");
			// The established bare plain-text code form behaves the same.
			const bare = classifyProviderHttpError("xai", status, "insufficient_quota");
			expect(bare?.message).toContain("credits exhausted");
		}
		// Unrelated structured codes stay out of the billing diagnosis.
		const authBody = JSON.stringify({
			error: { code: "invalid_api_key", type: "insufficient_quota_scope" },
			message: "Bad key",
		});
		expect(classifyProviderHttpError("xai", 403, authBody)?.message).toContain("403 forbidden");
	});

	it.each([
		["top-level type", JSON.stringify({ type: "insufficient_quota", message: "Generic provider failure" })],
		["error.type", JSON.stringify({ error: { type: "insufficient_quota", message: "Generic provider failure" } })],
	])("preserves the billing summary for %s on auth statuses", (_field, body) => {
		for (const status of [401, 403]) {
			const error = classifyProviderHttpError("xai", status, body);
			expect(formatSearchProviderFailure(error, { id: "xai", label: "xAI" })).toContain("credits exhausted");
		}
	});

	it("preserves quota-state and credit-insufficiency matches on auth statuses", () => {
		// Quota wording with a terminal state and bare credit insufficiency
		// are unambiguous exhaustion signals; the auth-status exclusion only
		// gates bare "quota"/"insufficient" prose.
		for (const body of ["quota exceeded", "quota exhausted", "exceeded quota", "insufficient credits"]) {
			for (const status of [401, 403]) {
				const error = classifyProviderHttpError("xai", status, body);
				expect(error?.message).toContain("credits exhausted");
			}
		}
		// Near-misses without a terminal state or credit word stay auth failures.
		for (const body of [
			"quota check failed",
			"load balancer request exceeded timeout",
			"billing webhook exceeded its retry deadline",
			"retry attempts exhausted",
			"usage limit configuration is invalid",
		]) {
			expect(classifyProviderHttpError("xai", 403, body)?.message).toContain("403 forbidden");
		}
	});

	it("keeps transient limits out of credit exhaustion", () => {
		// Concurrency caps and per-minute throttles are transient limits, not
		// depleted credit: they must not become a billing diagnosis even
		// though the wording holds a quota state.
		for (const body of [
			"Online prediction concurrent requests quota exceeded",
			"quota exceeded due to concurrent requests",
			"Requests per minute: quota exceeded",
		]) {
			expect(classifyProviderHttpError("xai", 403, body)?.message).toContain("403 forbidden");
			expect(classifyProviderHttpError("xai", 401, body)?.message).toContain("401 unauthorized");
		}
	});

	it("accepts copulas but rejects negated quota-state matches", () => {
		// Affirmative auxiliaries between quota and state keep the billing
		// diagnosis; negation anywhere in the construction stays an auth failure.
		for (const body of ["quota has been exceeded", "quota was exhausted"]) {
			expect(classifyProviderHttpError("xai", 403, body)?.message).toContain("credits exhausted");
		}
		for (const body of ["request has not exceeded quota", "haven't exceeded quota", "quota has not been exceeded"]) {
			expect(classifyProviderHttpError("xai", 403, body)?.message).toContain("403 forbidden");
		}
		// Negation stays effective across intervening adverbs.
		for (const body of ["never actually exceeded quota", "haven't actually exceeded quota"]) {
			expect(classifyProviderHttpError("xai", 403, body)?.message).toContain("403 forbidden");
		}
		// Concurrency qualification after the quota state is also excluded.
		expect(classifyProviderHttpError("xai", 403, "quota exceeded due to concurrent requests")?.message).toContain(
			"403 forbidden",
		);
	});

	it("still maps bare 402/401/403 statuses when the body is silent", () => {
		expect(classifyProviderHttpError("xai", 402, "")?.message).toContain("credits exhausted");
		expect(classifyProviderHttpError("xai", 401, "")?.message).toContain("401 unauthorized");
		expect(classifyProviderHttpError("xai", 403, "")?.message).toContain("403 forbidden");
	});
});
