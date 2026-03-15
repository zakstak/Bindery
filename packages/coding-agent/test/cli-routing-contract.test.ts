import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { globSync } from "glob";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { main } from "../src/main.js";

class ExitSignal extends Error {
	constructor(readonly code: number | undefined) {
		super(`process.exit(${code ?? "undefined"})`);
		this.name = "ExitSignal";
	}
}

const mocks = vi.hoisted(() => {
	const createAgentSession = vi.fn(async () => ({
		session: {
			model: { reasoning: true },
			thinkingLevel: "off",
			setThinkingLevel: vi.fn(),
		},
		modelFallbackMessage: undefined,
	}));

	return {
		createAgentSession,
		runPrintMode: vi.fn(async () => {}),
		runRpcMode: vi.fn(async () => {}),
		showDeprecationWarnings: vi.fn(async () => {}),
		printTimings: vi.fn(),
		time: vi.fn(),
		settingsManager: {
			drainErrors: vi.fn(() => []),
			getImageAutoResize: vi.fn(() => false),
			getTheme: vi.fn(() => "dark"),
			getEnabledModels: vi.fn(() => undefined),
			getQuietStartup: vi.fn(() => true),
			getDefaultProvider: vi.fn(() => undefined),
			getDefaultModel: vi.fn(() => undefined),
		},
		resourceLoader: {
			reload: vi.fn(async () => {}),
			getExtensions: vi.fn(() => ({
				errors: [],
				runtime: { pendingProviderRegistrations: [], flagValues: new Map() },
				extensions: [],
			})),
		},
		packageManager: {
			resolve: vi.fn(async () => ({})),
			setProgressCallback: vi.fn(),
			install: vi.fn(),
			addSourceToSettings: vi.fn(),
			remove: vi.fn(),
			removeSourceFromSettings: vi.fn(() => true),
			update: vi.fn(),
			getInstalledPath: vi.fn(() => undefined),
		},
		modelRegistry: {
			registerProvider: vi.fn(),
			find: vi.fn(() => undefined),
		},
		authStorage: {
			setRuntimeApiKey: vi.fn(),
		},
		sessionManager: {
			list: vi.fn(async () => []),
			listAll: vi.fn(async () => []),
			open: vi.fn(() => ({ kind: "open" })),
			create: vi.fn(() => ({ kind: "create" })),
			continueRecent: vi.fn(() => ({ kind: "continue" })),
			inMemory: vi.fn(() => ({ kind: "memory" })),
			forkFrom: vi.fn(async () => ({ kind: "fork" })),
		},
	};
});
vi.mock("../src/cli/file-processor.js", () => ({
	processFileArguments: vi.fn(async () => ({ text: "", images: [] })),
}));

vi.mock("../src/cli/list-models.js", () => ({
	listModels: vi.fn(async () => {}),
}));

vi.mock("../src/core/auth-storage.js", () => ({
	AuthStorage: {
		create: vi.fn(() => mocks.authStorage),
	},
}));

vi.mock("../src/core/export-html/index.js", () => ({
	exportFromFile: vi.fn(async () => "/tmp/export.html"),
}));

vi.mock("../src/core/keybindings.js", () => ({
	KeybindingsManager: {
		create: vi.fn(() => ({})),
	},
}));

vi.mock("../src/core/model-registry.js", () => ({
	ModelRegistry: vi.fn().mockImplementation(() => mocks.modelRegistry),
}));

vi.mock("../src/core/model-resolver.js", () => ({
	resolveCliModel: vi.fn(() => ({})),
	resolveModelScope: vi.fn(async () => []),
}));

vi.mock("../src/core/package-manager.js", () => ({
	DefaultPackageManager: vi.fn().mockImplementation(() => mocks.packageManager),
}));

vi.mock("../src/core/resource-loader.js", () => ({
	DefaultResourceLoader: vi.fn().mockImplementation(() => mocks.resourceLoader),
}));

vi.mock("../src/core/sdk.js", () => ({
	createAgentSession: mocks.createAgentSession,
}));

vi.mock("../src/core/session-manager.js", () => ({
	SessionManager: mocks.sessionManager,
}));

vi.mock("../src/core/settings-manager.js", () => ({
	SettingsManager: {
		create: vi.fn(() => mocks.settingsManager),
	},
}));

vi.mock("../src/core/timings.js", () => ({
	printTimings: mocks.printTimings,
	time: mocks.time,
}));

vi.mock("../src/migrations.js", () => ({
	runMigrations: vi.fn(() => ({ migratedAuthProviders: [], deprecationWarnings: [] })),
	showDeprecationWarnings: mocks.showDeprecationWarnings,
}));

vi.mock("../src/modes/index.js", () => ({
	runPrintMode: mocks.runPrintMode,
	runRpcMode: mocks.runRpcMode,
}));

vi.mock("../src/core/theme/theme.js", () => ({
	initTheme: vi.fn(),
	stopThemeWatcher: vi.fn(),
}));

function collectOutput(spy: ReturnType<typeof vi.spyOn>): string {
	return spy.mock.calls.flatMap((call) => call.map((value) => String(value))).join("\n");
}

function overrideIsTTY(stream: NodeJS.ReadStream | NodeJS.WriteStream, value: boolean): () => void {
	const descriptor = Object.getOwnPropertyDescriptor(stream, "isTTY");
	Object.defineProperty(stream, "isTTY", { configurable: true, value });
	return () => {
		if (descriptor) {
			Object.defineProperty(stream, "isTTY", descriptor);
		} else {
			Reflect.deleteProperty(stream, "isTTY");
		}
	};
}

async function runCli(args: string[]): Promise<{
	output: string;
	resultCode: number | undefined;
}> {
	const restoreStdin = overrideIsTTY(process.stdin, true);
	const restoreStdout = overrideIsTTY(process.stdout, true);
	const previousExitCode = process.exitCode;
	const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		throw new ExitSignal(code);
	}) as never);

	process.exitCode = undefined;

	try {
		let exitCode: number | undefined;
		try {
			await main(args);
		} catch (error) {
			if (error instanceof ExitSignal) {
				exitCode = error.code;
			} else {
				throw error;
			}
		}

		const output = [collectOutput(errorSpy), collectOutput(logSpy)].filter(Boolean).join("\n");
		return {
			output,
			resultCode: exitCode ?? process.exitCode,
		};
	} finally {
		errorSpy.mockRestore();
		logSpy.mockRestore();
		exitSpy.mockRestore();
		process.exitCode = previousExitCode;
		restoreStdin();
		restoreStdout();
	}
}

function expectHeadlessGuidance(output: string): void {
	expect(output).toContain("Bindery");
	expect(output).toContain("--print");
	expect(output).toContain("--mode rpc");
}

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

const retiredTuiRegressionFiles = [
	"packages/coding-agent/test/interactive-prompt-review-panel.test.ts",
	"packages/coding-agent/test/tool-execution-component.test.ts",
	"packages/coding-agent/test/interactive-mode-status.test.ts",
	"packages/coding-agent/test/session-selector-path-delete.test.ts",
	"packages/coding-agent/test/session-selector-rename.test.ts",
] as const;

const staleReferenceRules = [
	{ label: "@mariozechner/pi-tui", regex: /@mariozechner\/pi-tui/ },
	{ label: ["Interactive", "Mode"].join(""), regex: new RegExp("\\bInteractive" + "Mode\\b") },
	{ label: "run-agent", regex: /\brun-agent\b/ },
	{ label: "SessionSelectorComponent", regex: /\bSessionSelectorComponent\b/ },
	{ label: "ConfigSelectorComponent", regex: /\bConfigSelectorComponent\b/ },
] as const;

function collectLiveRepoFiles(): string[] {
	const patterns = [
		"README.md",
		"bindery/**/*.{html,md,rs,toml}",
		"packages/coding-agent/README.md",
		"packages/coding-agent/docs/**/*.md",
		"packages/coding-agent/src/**/*.ts",
		"scripts/**/*.{js,md,sh,ts}",
		"*.sh",
	] as const;

	return patterns
		.flatMap((pattern) => globSync(pattern, { cwd: repoRoot, nodir: true }))
		.filter((filePath, index, values) => values.indexOf(filePath) === index)
		.sort();
}

function collectStaleReferenceMatches(): string[] {
	const matches: string[] = [];

	for (const relativePath of collectLiveRepoFiles()) {
		const content = readFileSync(resolve(repoRoot, relativePath), "utf8");
		for (const rule of staleReferenceRules) {
			if (rule.regex.test(content)) {
				matches.push(`${relativePath}: ${rule.label}`);
			}
		}
	}

	return matches;
}

describe("CLI routing contract", () => {
	let originalAgentDir: string | undefined;

	beforeEach(() => {
		vi.clearAllMocks();
		originalAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = "/tmp/bindery-agent-test";
	});

	afterEach(() => {
		if (originalAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
	});

	it("routes bare pi on a tty to migration guidance instead of the removed terminal mode", async () => {
		const result = await runCli([]);

		expect(result.resultCode).toBe(1);
		expectHeadlessGuidance(result.output);
		expect(result.output.toLowerCase()).toContain("interactive");
		expect(mocks.runPrintMode).not.toHaveBeenCalled();
		expect(mocks.runRpcMode).not.toHaveBeenCalled();
	});

	it("routes --resume to deterministic replacement guidance without opening a selector", async () => {
		const result = await runCli(["--resume"]);

		expect(result.resultCode).toBe(1);
		expectHeadlessGuidance(result.output);
		expect(result.output).toContain("--session");
	});

	it("routes pi config to deterministic replacement guidance without opening the TUI config selector", async () => {
		const result = await runCli(["config"]);

		expect(result.resultCode).toBe(1);
		expectHeadlessGuidance(result.output);
		expect(result.output).toContain("settings.json");
	});

	it("retires TUI-only selector and renderer regression files", () => {
		for (const relativePath of retiredTuiRegressionFiles) {
			expect(existsSync(resolve(repoRoot, relativePath)), relativePath).toBe(false);
		}
	});

	it("keeps live source and docs free of retired TUI references", () => {
		expect(collectStaleReferenceMatches()).toEqual([]);
	});
});
