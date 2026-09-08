import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { searchXAI } from "@oh-my-pi/pi-coding-agent/web/search/providers/xai";

const XAI_ENV_KEYS = ["XAI_API_KEY", "XAI_OAUTH_TOKEN", "XAI_SEARCH_MODEL"] as const;

const originalEnv: Partial<Record<(typeof XAI_ENV_KEYS)[number], string | undefined>> = {};

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

const fakeAuthStorage = {
	resolver: vi.fn(() => async () => "test-key"),
	getCredentialOrigin: vi.fn(() => undefined),
	hasAuth: vi.fn(() => true),
} as unknown as AuthStorage;

interface CapturedRequest {
	url: string;
	body: Record<string, unknown>;
}

const baseResponse = {
	id: "resp-test",
	model: "grok-4.6",
	output_text: "Bun 1.3.12 is the latest release.",
	output: [],
	usage: { input_tokens: 10, output_tokens: 5 },
};

function makeFetchMock(response: Record<string, unknown> = baseResponse): {
	fetch: FetchImpl;
	captured: CapturedRequest[];
} {
	const captured: CapturedRequest[] = [];
	const fetchMock: FetchImpl = async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
		const body = JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>;
		captured.push({ url, body });
		return new Response(JSON.stringify(response), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	};
	return { fetch: fetchMock, captured };
}

function makeParams(fetch: FetchImpl, extras: Record<string, unknown> = {}) {
	return {
		query: "Bun latest release",
		systemPrompt: "xAI integration test prompt",
		authStorage: fakeAuthStorage,
		fetch,
		...extras,
	};
}

describe("xAI Responses web search model selection", () => {
	beforeEach(() => {
		for (const key of XAI_ENV_KEYS) {
			originalEnv[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(() => {
		vi.restoreAllMocks();
		for (const key of XAI_ENV_KEYS) {
			restoreEnv(key, originalEnv[key]);
		}
	});

	it("defaults to grok-4.6 on the wire", async () => {
		const { fetch, captured } = makeFetchMock();

		const response = await searchXAI(makeParams(fetch));

		expect(captured).toHaveLength(1);
		expect(captured[0]?.url).toBe("https://api.x.ai/v1/responses");
		expect(captured[0]?.body.model).toBe("grok-4.6");
		expect(response.provider).toBe("xai");
		expect(response.answer).toBe("Bun 1.3.12 is the latest release.");
	});

	it("honors an explicit xaiModel param over the default", async () => {
		const { fetch, captured } = makeFetchMock();

		await searchXAI(makeParams(fetch, { xaiModel: "grok-4.3" }));

		expect(captured[0]?.body.model).toBe("grok-4.3");
	});

	it("lets XAI_SEARCH_MODEL override the default", async () => {
		process.env.XAI_SEARCH_MODEL = "grok-4.3";
		const { fetch, captured } = makeFetchMock();

		await searchXAI(makeParams(fetch));

		expect(captured[0]?.body.model).toBe("grok-4.3");
	});

	it("prefers XAI_SEARCH_MODEL over the configured xaiModel", async () => {
		process.env.XAI_SEARCH_MODEL = "grok-4.3";
		const { fetch, captured } = makeFetchMock();

		await searchXAI(makeParams(fetch, { xaiModel: "grok-4.5" }));

		expect(captured[0]?.body.model).toBe("grok-4.3");
	});
});

describe("xAI Responses relay (custom baseUrl) support", () => {
	const originalBaseUrl = process.env.XAI_BASE_URL;

	beforeEach(() => {
		for (const key of XAI_ENV_KEYS) {
			originalEnv[key] = process.env[key];
			delete process.env[key];
		}
		delete process.env.XAI_BASE_URL;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		for (const key of XAI_ENV_KEYS) {
			restoreEnv(key, originalEnv[key]);
		}
		if (originalBaseUrl === undefined) delete process.env.XAI_BASE_URL;
		else process.env.XAI_BASE_URL = originalBaseUrl;
	});

	it("posts to the XAI_BASE_URL relay with the xai api key when no model registry is present", async () => {
		process.env.XAI_BASE_URL = "https://relay.example.com/v1";
		const { fetch, captured } = makeFetchMock();

		await searchXAI(makeParams(fetch));

		expect(captured).toHaveLength(1);
		expect(captured[0]?.url).toBe("https://relay.example.com/v1/responses");
		expect(captured[0]?.body.model).toBe("grok-4.6");
	});
});
