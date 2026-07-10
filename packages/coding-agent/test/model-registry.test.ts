import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Context, Model, OpenAICompletionsCompat } from "@earendil-works/pi-ai/compat";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { getOAuthProvider } from "@earendil-works/pi-ai/oauth";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { clearApiKeyCache, ModelRegistry } from "../src/core/model-registry.js";

describe("ModelRegistry", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-test-model-registry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = join(tempDir, "models.json");
		authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
		clearApiKeyCache();
	});

	/** Create minimal provider config  */
	function providerConfig(
		baseUrl: string,
		models: Array<{ id: string; name?: string }>,
		api: string = "anthropic-messages",
	) {
		return {
			baseUrl,
			apiKey: "TEST_KEY",
			api,
			models: models.map((m) => ({
				id: m.id,
				name: m.name ?? m.id,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100000,
				maxTokens: 8000,
			})),
		};
	}

	function writeModelsJson(providers: Record<string, ReturnType<typeof providerConfig>>) {
		writeFileSync(modelsJsonPath, JSON.stringify({ providers }));
	}

	function getModelsForProvider(registry: ModelRegistry, provider: string) {
		return registry.getAll().filter((m) => m.provider === provider);
	}

	function getBuiltInModels(provider: string) {
		return getModelsForProvider(new ModelRegistry(authStorage, undefined), provider);
	}

	/** Create a baseUrl-only override (no custom models) */
	function overrideConfig(baseUrl: string, headers?: Record<string, string>) {
		return { baseUrl, ...(headers && { headers }) };
	}

	/** Write raw providers config (for mixed override/replacement scenarios) */
	function writeRawModelsJson(providers: Record<string, unknown>) {
		writeFileSync(modelsJsonPath, JSON.stringify({ providers }));
	}

	const openAiModel: Model<Api> = {
		id: "test-openai-model",
		name: "Test OpenAI Model",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};

	const emptyContext: Context = {
		messages: [],
	};

	describe("baseUrl override (no custom models)", () => {
		test("overriding baseUrl keeps all built-in models", () => {
			const builtInOpenAiModels = getBuiltInModels("openai");

			writeRawModelsJson({
				openai: overrideConfig("https://my-proxy.example.com/v1"),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const openAiModels = getModelsForProvider(registry, "openai");

			expect(openAiModels.map((m) => m.id)).toEqual(builtInOpenAiModels.map((m) => m.id));
		});

		test("overriding baseUrl changes URL on all built-in models", () => {
			writeRawModelsJson({
				openai: overrideConfig("https://my-proxy.example.com/v1"),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const openAiModels = getModelsForProvider(registry, "openai");

			// All models should have the new baseUrl
			for (const model of openAiModels) {
				expect(model.baseUrl).toBe("https://my-proxy.example.com/v1");
			}
		});

		test("overriding headers merges with model headers", () => {
			writeRawModelsJson({
				openai: overrideConfig("https://my-proxy.example.com/v1", {
					"X-Custom-Header": "custom-value",
				}),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const openAiModels = getModelsForProvider(registry, "openai");

			for (const model of openAiModels) {
				expect(model.headers?.["X-Custom-Header"]).toBe("custom-value");
			}
		});

		test("baseUrl-only override does not affect other providers", () => {
			writeRawModelsJson({
				openai: overrideConfig("https://my-proxy.example.com/v1"),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const googleModels = getModelsForProvider(registry, "google");

			// Google models should still have their original baseUrl
			expect(googleModels.length).toBeGreaterThan(0);
			expect(googleModels[0].baseUrl).not.toBe("https://my-proxy.example.com/v1");
		});

		test("can mix baseUrl override and models merge", () => {
			const builtInOpenAiModels = getBuiltInModels("openai");

			writeRawModelsJson({
				openai: overrideConfig("https://openai-proxy.example.com/v1"),
				google: providerConfig(
					"https://google-proxy.example.com/v1",
					[{ id: "gemini-custom" }],
					"google-generative-ai",
				),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			const openAiModels = getModelsForProvider(registry, "openai");
			expect(openAiModels.map((m) => m.id)).toEqual(builtInOpenAiModels.map((m) => m.id));
			expect(openAiModels[0].baseUrl).toBe("https://openai-proxy.example.com/v1");

			const googleModels = getModelsForProvider(registry, "google");
			expect(googleModels.length).toBeGreaterThan(1);
			expect(googleModels.some((m) => m.id === "gemini-custom")).toBe(true);
		});

		test("refresh() picks up baseUrl override changes", () => {
			writeRawModelsJson({
				openai: overrideConfig("https://first-proxy.example.com/v1"),
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			expect(getModelsForProvider(registry, "openai")[0].baseUrl).toBe("https://first-proxy.example.com/v1");

			// Update and refresh
			writeRawModelsJson({
				openai: overrideConfig("https://second-proxy.example.com/v1"),
			});
			registry.refresh();

			expect(getModelsForProvider(registry, "openai")[0].baseUrl).toBe("https://second-proxy.example.com/v1");
		});

		test("override-only config for removed built-ins does not materialize models", () => {
			writeRawModelsJson({
				anthropic: overrideConfig("https://removed-provider.example.com/v1"),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			expect(getModelsForProvider(registry, "anthropic")).toHaveLength(0);
			expect(registry.getError()).toBeUndefined();
		});
	});

	describe("custom models merge behavior", () => {
		test("custom provider with same name as built-in merges with built-in models", () => {
			const builtInOpenAiModels = getBuiltInModels("openai");

			writeModelsJson({
				openai: providerConfig("https://my-proxy.example.com/v1", [{ id: "gpt-custom" }], "openai-responses"),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const openAiModels = getModelsForProvider(registry, "openai");

			expect(openAiModels).toHaveLength(builtInOpenAiModels.length + 1);
			expect(openAiModels.some((m) => m.id === "gpt-custom")).toBe(true);
		});

		test("custom model with same id replaces built-in model by id", () => {
			const builtInOpenAiModelId = getBuiltInModels("openai")[0]?.id;
			expect(builtInOpenAiModelId).toBeDefined();

			writeModelsJson({
				openai: providerConfig(
					"https://my-proxy.example.com/v1",
					[{ id: builtInOpenAiModelId! }],
					"openai-responses",
				),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openai");
			const matchingModels = models.filter((m) => m.id === builtInOpenAiModelId);

			expect(matchingModels).toHaveLength(1);
			expect(matchingModels[0].baseUrl).toBe("https://my-proxy.example.com/v1");
		});

		test("custom provider with same name as built-in does not affect other built-in providers", () => {
			writeModelsJson({
				openai: providerConfig("https://my-proxy.example.com/v1", [{ id: "gpt-custom" }], "openai-responses"),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			expect(getModelsForProvider(registry, "google").length).toBeGreaterThan(0);
			expect(getModelsForProvider(registry, "zai").length).toBeGreaterThan(0);
		});

		test("provider-level baseUrl applies to both built-in and custom models", () => {
			const builtInOpenAiModels = getBuiltInModels("openai");

			writeModelsJson({
				openai: providerConfig("https://merged-proxy.example.com/v1", [{ id: "gpt-custom" }], "openai-responses"),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const openAiModels = getModelsForProvider(registry, "openai");

			expect(openAiModels).toHaveLength(builtInOpenAiModels.length + 1);
			for (const model of openAiModels) {
				expect(model.baseUrl).toBe("https://merged-proxy.example.com/v1");
			}
		});

		test("model-level baseUrl overrides provider-level baseUrl for custom models", () => {
			writeRawModelsJson({
				"opencode-go": {
					baseUrl: "https://opencode.ai/zen/go/v1",
					apiKey: "TEST_KEY",
					models: [
						{
							id: "minimax-m2.5",
							api: "anthropic-messages",
							baseUrl: "https://opencode.ai/zen/go",
							reasoning: true,
							input: ["text"],
							cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0 },
							contextWindow: 204800,
							maxTokens: 131072,
						},
						{
							id: "glm-5",
							api: "openai-completions",
							reasoning: true,
							input: ["text"],
							cost: { input: 1, output: 3.2, cacheRead: 0.2, cacheWrite: 0 },
							contextWindow: 204800,
							maxTokens: 131072,
						},
					],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const m25 = registry.find("opencode-go", "minimax-m2.5");
			const glm5 = registry.find("opencode-go", "glm-5");

			expect(m25?.baseUrl).toBe("https://opencode.ai/zen/go");
			expect(glm5?.baseUrl).toBe("https://opencode.ai/zen/go/v1");
		});

		test("modelOverrides still apply when provider also defines models", () => {
			const builtInOpenAiModelId = getBuiltInModels("openai")[0]?.id;
			expect(builtInOpenAiModelId).toBeDefined();

			writeRawModelsJson({
				openai: {
					baseUrl: "https://my-proxy.example.com/v1",
					apiKey: "OPENAI_API_KEY",
					api: "openai-responses",
					models: [
						{
							id: "gpt-custom",
							name: "Custom OpenAI Model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 16384,
						},
					],
					modelOverrides: {
						[builtInOpenAiModelId!]: {
							name: "Overridden Built-in OpenAI Model",
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openai");

			expect(models.some((m) => m.id === "gpt-custom")).toBe(true);
			expect(
				models.some((m) => m.id === builtInOpenAiModelId && m.name === "Overridden Built-in OpenAI Model"),
			).toBe(true);
		});

		test("refresh() reloads merged custom models from disk", () => {
			writeModelsJson({
				openai: providerConfig("https://first-proxy.example.com/v1", [{ id: "gpt-custom" }], "openai-responses"),
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(getModelsForProvider(registry, "openai").some((m) => m.id === "gpt-custom")).toBe(true);

			// Update and refresh
			writeModelsJson({
				openai: providerConfig("https://second-proxy.example.com/v1", [{ id: "gpt-custom-2" }], "openai-responses"),
			});
			registry.refresh();

			const openAiModels = getModelsForProvider(registry, "openai");
			expect(openAiModels.some((m) => m.id === "gpt-custom")).toBe(false);
			expect(openAiModels.some((m) => m.id === "gpt-custom-2")).toBe(true);
			expect(openAiModels.length).toBeGreaterThan(1);
		});

		test("removing custom models from models.json keeps built-in provider models", () => {
			const builtInOpenAiModels = getBuiltInModels("openai");

			writeModelsJson({
				openai: providerConfig("https://proxy.example.com/v1", [{ id: "gpt-custom" }], "openai-responses"),
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(getModelsForProvider(registry, "openai").some((m) => m.id === "gpt-custom")).toBe(true);

			// Remove custom models and refresh
			writeModelsJson({});
			registry.refresh();

			const openAiModels = getModelsForProvider(registry, "openai");
			expect(openAiModels.some((m) => m.id === "gpt-custom")).toBe(false);
			expect(openAiModels.map((m) => m.id)).toEqual(builtInOpenAiModels.map((m) => m.id));
		});
	});

	describe("modelOverrides (per-model customization)", () => {
		test("model override applies to a single built-in model", () => {
			const [firstOpenAiModel, secondOpenAiModel] = getBuiltInModels("openai");
			expect(firstOpenAiModel).toBeDefined();
			expect(secondOpenAiModel).toBeDefined();

			writeRawModelsJson({
				openai: {
					modelOverrides: {
						[firstOpenAiModel!.id]: {
							name: "Custom Sonnet Name",
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openai");

			const overriddenModel = models.find((m) => m.id === firstOpenAiModel!.id);
			expect(overriddenModel?.name).toBe("Custom Sonnet Name");

			// Other models should be unchanged
			const untouchedModel = models.find((m) => m.id === secondOpenAiModel!.id);
			expect(untouchedModel?.name).not.toBe("Custom Sonnet Name");
		});

		test("model override with compat.openRouterRouting", () => {
			const firstOpenAiModelId = getBuiltInModels("openai")[0]?.id;
			expect(firstOpenAiModelId).toBeDefined();

			writeRawModelsJson({
				openai: {
					modelOverrides: {
						[firstOpenAiModelId!]: {
							compat: {
								openRouterRouting: { only: ["amazon-bedrock"] },
							},
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openai");

			const overriddenModel = models.find((m) => m.id === firstOpenAiModelId);
			const compat = overriddenModel?.compat as OpenAICompletionsCompat | undefined;
			expect(compat?.openRouterRouting).toEqual({ only: ["amazon-bedrock"] });
		});

		test("model override deep merges compat settings", () => {
			const firstOpenAiModelId = getBuiltInModels("openai")[0]?.id;
			expect(firstOpenAiModelId).toBeDefined();

			writeRawModelsJson({
				openai: {
					modelOverrides: {
						[firstOpenAiModelId!]: {
							compat: {
								openRouterRouting: { order: ["anthropic", "together"] },
							},
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openai");
			const overriddenModel = models.find((m) => m.id === firstOpenAiModelId);

			// Should have both the new routing AND preserve other compat settings
			const compat = overriddenModel?.compat as OpenAICompletionsCompat | undefined;
			expect(compat?.openRouterRouting).toEqual({ order: ["anthropic", "together"] });
		});

		test("multiple model overrides on same provider", () => {
			const [firstOpenAiModel, secondOpenAiModel] = getBuiltInModels("openai");
			expect(firstOpenAiModel).toBeDefined();
			expect(secondOpenAiModel).toBeDefined();

			writeRawModelsJson({
				openai: {
					modelOverrides: {
						[firstOpenAiModel!.id]: {
							compat: { openRouterRouting: { only: ["amazon-bedrock"] } },
						},
						[secondOpenAiModel!.id]: {
							compat: { openRouterRouting: { only: ["anthropic"] } },
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openai");

			const firstModel = models.find((m) => m.id === firstOpenAiModel!.id);
			const secondModel = models.find((m) => m.id === secondOpenAiModel!.id);

			const firstCompat = firstModel?.compat as OpenAICompletionsCompat | undefined;
			const secondCompat = secondModel?.compat as OpenAICompletionsCompat | undefined;
			expect(firstCompat?.openRouterRouting).toEqual({ only: ["amazon-bedrock"] });
			expect(secondCompat?.openRouterRouting).toEqual({ only: ["anthropic"] });
		});

		test("model override combined with baseUrl override", () => {
			const [firstOpenAiModel, secondOpenAiModel] = getBuiltInModels("openai");
			expect(firstOpenAiModel).toBeDefined();
			expect(secondOpenAiModel).toBeDefined();

			writeRawModelsJson({
				openai: {
					baseUrl: "https://my-proxy.example.com/v1",
					modelOverrides: {
						[firstOpenAiModel!.id]: {
							name: "Proxied Sonnet",
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openai");
			const overriddenModel = models.find((m) => m.id === firstOpenAiModel!.id);

			// Both overrides should apply
			expect(overriddenModel?.baseUrl).toBe("https://my-proxy.example.com/v1");
			expect(overriddenModel?.name).toBe("Proxied Sonnet");

			// Other models should have the baseUrl but not the name override
			const untouchedModel = models.find((m) => m.id === secondOpenAiModel!.id);
			expect(untouchedModel?.baseUrl).toBe("https://my-proxy.example.com/v1");
			expect(untouchedModel?.name).not.toBe("Proxied Sonnet");
		});

		test("model override for non-existent model ID is ignored", () => {
			writeRawModelsJson({
				openai: {
					modelOverrides: {
						"nonexistent/model-id": {
							name: "This should not appear",
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openai");

			// Should not create a new model
			expect(models.find((m) => m.id === "nonexistent/model-id")).toBeUndefined();
			// Should not crash or show error
			expect(registry.getError()).toBeUndefined();
		});

		test("model override can change cost fields partially", () => {
			const firstOpenAiModelId = getBuiltInModels("openai")[0]?.id;
			expect(firstOpenAiModelId).toBeDefined();

			writeRawModelsJson({
				openai: {
					modelOverrides: {
						[firstOpenAiModelId!]: {
							cost: { input: 99 },
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openai");
			const overriddenModel = models.find((m) => m.id === firstOpenAiModelId);

			// Input cost should be overridden
			expect(overriddenModel?.cost.input).toBe(99);
			// Other cost fields should be preserved from built-in
			expect(overriddenModel?.cost.output).toBeGreaterThan(0);
		});

		test("model override can add headers", () => {
			const firstOpenAiModelId = getBuiltInModels("openai")[0]?.id;
			expect(firstOpenAiModelId).toBeDefined();

			writeRawModelsJson({
				openai: {
					modelOverrides: {
						[firstOpenAiModelId!]: {
							headers: { "X-Custom-Model-Header": "value" },
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openai");
			const overriddenModel = models.find((m) => m.id === firstOpenAiModelId);

			expect(overriddenModel?.headers?.["X-Custom-Model-Header"]).toBe("value");
		});

		test("refresh() picks up model override changes", () => {
			const firstOpenAiModelId = getBuiltInModels("openai")[0]?.id;
			expect(firstOpenAiModelId).toBeDefined();

			writeRawModelsJson({
				openai: {
					modelOverrides: {
						[firstOpenAiModelId!]: {
							name: "First Name",
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(getModelsForProvider(registry, "openai").find((m) => m.id === firstOpenAiModelId)?.name).toBe(
				"First Name",
			);

			// Update and refresh
			writeRawModelsJson({
				openai: {
					modelOverrides: {
						[firstOpenAiModelId!]: {
							name: "Second Name",
						},
					},
				},
			});
			registry.refresh();

			expect(getModelsForProvider(registry, "openai").find((m) => m.id === firstOpenAiModelId)?.name).toBe(
				"Second Name",
			);
		});

		test("removing model override restores built-in values", () => {
			const firstOpenAiModelId = getBuiltInModels("openai")[0]?.id;
			expect(firstOpenAiModelId).toBeDefined();

			writeRawModelsJson({
				openai: {
					modelOverrides: {
						[firstOpenAiModelId!]: {
							name: "Custom Name",
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const customName = getModelsForProvider(registry, "openai").find((m) => m.id === firstOpenAiModelId)?.name;
			expect(customName).toBe("Custom Name");

			// Remove override and refresh
			writeRawModelsJson({});
			registry.refresh();

			const restoredName = getModelsForProvider(registry, "openai").find((m) => m.id === firstOpenAiModelId)?.name;
			expect(restoredName).not.toBe("Custom Name");
		});
	});

	describe("dynamic provider lifecycle", () => {
		test("unregisterProvider removes custom OAuth provider and restores built-in OAuth provider", () => {
			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			registry.registerProvider("google-gemini-cli", {
				oauth: {
					name: "Custom Gemini OAuth",
					login: async () => ({
						access: "custom-access-token",
						refresh: "custom-refresh-token",
						expires: Date.now() + 60_000,
					}),
					refreshToken: async (credentials) => credentials,
					getApiKey: (credentials) => credentials.access,
				},
			});

			expect(getOAuthProvider("google-gemini-cli")?.name).toBe("Custom Gemini OAuth");

			registry.unregisterProvider("google-gemini-cli");

			expect(getOAuthProvider("google-gemini-cli")?.name).not.toBe("Custom Gemini OAuth");
		});

		test("unregisterProvider removes custom streamSimple override and restores built-in API stream handler", () => {
			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			registry.registerProvider("stream-override-provider", {
				api: "openai-completions",
				streamSimple: () => {
					throw new Error("custom streamSimple override");
				},
			});

			let threwCustomOverride = false;
			try {
				getApiProvider("openai-completions")?.streamSimple(openAiModel, emptyContext);
			} catch (error) {
				threwCustomOverride = error instanceof Error && error.message === "custom streamSimple override";
			}
			expect(threwCustomOverride).toBe(true);

			registry.unregisterProvider("stream-override-provider");

			let threwCustomOverrideAfterUnregister = false;
			try {
				getApiProvider("openai-completions")?.streamSimple(openAiModel, emptyContext);
			} catch (error) {
				threwCustomOverrideAfterUnregister =
					error instanceof Error && error.message === "custom streamSimple override";
			}
			expect(threwCustomOverrideAfterUnregister).toBe(false);
		});
	});

	describe("API key resolution", () => {
		/** Create provider config with custom apiKey */
		function providerWithApiKey(apiKey: string) {
			return {
				baseUrl: "https://example.com/v1",
				apiKey,
				api: "anthropic-messages",
				models: [
					{
						id: "test-model",
						name: "Test Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 100000,
						maxTokens: 8000,
					},
				],
			};
		}

		test("apiKey with ! prefix executes command and uses stdout", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!echo test-api-key-from-command"),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBe("test-api-key-from-command");
		});

		test("apiKey with ! prefix trims whitespace from command output", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!echo '  spaced-key  '"),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBe("spaced-key");
		});

		test("apiKey with ! prefix handles multiline output (uses trimmed result)", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!printf 'line1\\nline2'"),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBe("line1\nline2");
		});

		test("apiKey with ! prefix returns undefined on command failure", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!exit 1"),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBeUndefined();
		});

		test("apiKey with ! prefix returns undefined on nonexistent command", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!nonexistent-command-12345"),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBeUndefined();
		});

		test("apiKey with ! prefix returns undefined on empty output", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!printf ''"),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBeUndefined();
		});

		test("apiKey as environment variable name resolves to env value", async () => {
			const originalEnv = process.env.TEST_API_KEY_12345;
			process.env.TEST_API_KEY_12345 = "env-api-key-value";

			try {
				writeRawModelsJson({
					"custom-provider": providerWithApiKey("TEST_API_KEY_12345"),
				});

				const registry = new ModelRegistry(authStorage, modelsJsonPath);
				const apiKey = await registry.getApiKeyForProvider("custom-provider");

				expect(apiKey).toBe("env-api-key-value");
			} finally {
				if (originalEnv === undefined) {
					delete process.env.TEST_API_KEY_12345;
				} else {
					process.env.TEST_API_KEY_12345 = originalEnv;
				}
			}
		});

		test("apiKey as literal value is used directly when not an env var", async () => {
			// Make sure this isn't an env var
			delete process.env.literal_api_key_value;

			writeRawModelsJson({
				"custom-provider": providerWithApiKey("literal_api_key_value"),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBe("literal_api_key_value");
		});

		test("apiKey command can use shell features like pipes", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!echo 'hello world' | tr ' ' '-'"),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBe("hello-world");
		});

		describe("caching", () => {
			test("command is only executed once per process", async () => {
				// Use a command that writes to a file to count invocations
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const command = `!sh -c 'count=$(cat ${counterFile}); echo $((count + 1)) > ${counterFile}; echo "key-value"'`;
				writeRawModelsJson({
					"custom-provider": providerWithApiKey(command),
				});

				const registry = new ModelRegistry(authStorage, modelsJsonPath);

				// Call multiple times
				await registry.getApiKeyForProvider("custom-provider");
				await registry.getApiKeyForProvider("custom-provider");
				await registry.getApiKeyForProvider("custom-provider");

				// Command should have only run once
				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(1);
			});

			test("cache persists across registry instances", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const command = `!sh -c 'count=$(cat ${counterFile}); echo $((count + 1)) > ${counterFile}; echo "key-value"'`;
				writeRawModelsJson({
					"custom-provider": providerWithApiKey(command),
				});

				// Create multiple registry instances
				const registry1 = new ModelRegistry(authStorage, modelsJsonPath);
				await registry1.getApiKeyForProvider("custom-provider");

				const registry2 = new ModelRegistry(authStorage, modelsJsonPath);
				await registry2.getApiKeyForProvider("custom-provider");

				// Command should still have only run once
				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(1);
			});

			test("clearApiKeyCache allows command to run again", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const command = `!sh -c 'count=$(cat ${counterFile}); echo $((count + 1)) > ${counterFile}; echo "key-value"'`;
				writeRawModelsJson({
					"custom-provider": providerWithApiKey(command),
				});

				const registry = new ModelRegistry(authStorage, modelsJsonPath);
				await registry.getApiKeyForProvider("custom-provider");

				// Clear cache and call again
				clearApiKeyCache();
				await registry.getApiKeyForProvider("custom-provider");

				// Command should have run twice
				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(2);
			});

			test("different commands are cached separately", async () => {
				writeRawModelsJson({
					"provider-a": providerWithApiKey("!echo key-a"),
					"provider-b": providerWithApiKey("!echo key-b"),
				});

				const registry = new ModelRegistry(authStorage, modelsJsonPath);

				const keyA = await registry.getApiKeyForProvider("provider-a");
				const keyB = await registry.getApiKeyForProvider("provider-b");

				expect(keyA).toBe("key-a");
				expect(keyB).toBe("key-b");
			});

			test("failed commands are cached (not retried)", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const command = `!sh -c 'count=$(cat ${counterFile}); echo $((count + 1)) > ${counterFile}; exit 1'`;
				writeRawModelsJson({
					"custom-provider": providerWithApiKey(command),
				});

				const registry = new ModelRegistry(authStorage, modelsJsonPath);

				// Call multiple times - all should return undefined
				const key1 = await registry.getApiKeyForProvider("custom-provider");
				const key2 = await registry.getApiKeyForProvider("custom-provider");

				expect(key1).toBeUndefined();
				expect(key2).toBeUndefined();

				// Command should have only run once despite failures
				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(1);
			});

			test("environment variables are not cached (changes are picked up)", async () => {
				const envVarName = "TEST_API_KEY_CACHE_TEST_98765";
				const originalEnv = process.env[envVarName];

				try {
					process.env[envVarName] = "first-value";

					writeRawModelsJson({
						"custom-provider": providerWithApiKey(envVarName),
					});

					const registry = new ModelRegistry(authStorage, modelsJsonPath);

					const key1 = await registry.getApiKeyForProvider("custom-provider");
					expect(key1).toBe("first-value");

					// Change env var
					process.env[envVarName] = "second-value";

					const key2 = await registry.getApiKeyForProvider("custom-provider");
					expect(key2).toBe("second-value");
				} finally {
					if (originalEnv === undefined) {
						delete process.env[envVarName];
					} else {
						process.env[envVarName] = originalEnv;
					}
				}
			});
		});
	});
});
