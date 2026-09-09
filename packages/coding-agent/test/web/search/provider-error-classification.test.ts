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
		["credit balance", "Your credit balance has been exhausted"],
		["billing suspension", "billing account suspended"],
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

	it("still maps bare 402/401/403 statuses when the body is silent", () => {
		expect(classifyProviderHttpError("xai", 402, "")?.message).toContain("credits exhausted");
		expect(classifyProviderHttpError("xai", 401, "")?.message).toContain("401 unauthorized");
		expect(classifyProviderHttpError("xai", 403, "")?.message).toContain("403 forbidden");
	});
});
