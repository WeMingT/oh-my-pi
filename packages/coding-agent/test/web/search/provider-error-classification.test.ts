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

	it("still maps bare 402/401/403 statuses when the body is silent", () => {
		expect(classifyProviderHttpError("xai", 402, "")?.message).toContain("credits exhausted");
		expect(classifyProviderHttpError("xai", 401, "")?.message).toContain("401 unauthorized");
		expect(classifyProviderHttpError("xai", 403, "")?.message).toContain("403 forbidden");
	});
});
