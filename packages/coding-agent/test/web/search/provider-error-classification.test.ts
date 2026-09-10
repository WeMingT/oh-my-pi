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
	});

	it("preserves structured insufficient_quota codes on auth statuses", () => {
		// The code is an explicit quota signal even when the envelope message
		// is generic; the auth-status exclusion only gates ambiguous wording.
		const body = JSON.stringify({ error: { code: "insufficient_quota" }, message: "Generic provider failure" });
		for (const status of [401, 403]) {
			const error = classifyProviderHttpError("xai", status, body);
			expect(error?.message).toContain("credits exhausted");
		}
		// Unrelated structured codes stay out of the billing diagnosis.
		const authBody = JSON.stringify({ error: { code: "invalid_api_key" }, message: "Bad key" });
		expect(classifyProviderHttpError("xai", 403, authBody)?.message).toContain("403 forbidden");
	});

	it("still maps bare 402/401/403 statuses when the body is silent", () => {
		expect(classifyProviderHttpError("xai", 402, "")?.message).toContain("credits exhausted");
		expect(classifyProviderHttpError("xai", 401, "")?.message).toContain("401 unauthorized");
		expect(classifyProviderHttpError("xai", 403, "")?.message).toContain("403 forbidden");
	});
});
