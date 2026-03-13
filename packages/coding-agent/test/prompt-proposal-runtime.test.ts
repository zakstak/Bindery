import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@mariozechner/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getModel,
	type Model,
} from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function assistantMessage(text: string, model: Model<any>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

interface RuntimeSessionContext {
	tempDir: string;
	systemPromptPath: string;
	session: AgentSession;
	sessionManager: SessionManager;
	resourceLoader: DefaultResourceLoader;
	modelRegistry: ModelRegistry;
}

const contexts: RuntimeSessionContext[] = [];

async function createRuntimeSession(initialSystemPrompt: string): Promise<RuntimeSessionContext> {
	const tempDir = join(tmpdir(), `pi-prompt-proposal-runtime-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const agentDir = join(tempDir, "agent");
	const cwd = join(tempDir, "project");
	const systemPromptPath = join(cwd, ".pi", "SYSTEM.md");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(systemPromptPath, initialSystemPrompt);

	const settingsManager = SettingsManager.create(cwd, agentDir);
	const sessionManager = SessionManager.create(cwd);
	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.json"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");

	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: [
			(pi) => {
				pi.on("before_agent_start", async (event) => ({
					systemPrompt: `${event.systemPrompt}\n\nRuntime proposal from extension`,
				}));
			},
		],
	});
	await resourceLoader.reload();

	const model = getModel("anthropic", "claude-sonnet-4-5");
	if (!model) {
		throw new Error("Expected claude-sonnet-4-5 model to be available in tests");
	}

	const agent = new Agent({
		getApiKey: async () => "test-key",
		initialState: {
			model,
			systemPrompt: "",
			tools: [],
		},
		streamFn: async () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: assistantMessage("", model) });
				stream.push({ type: "done", reason: "stop", message: assistantMessage("ok", model) });
			});
			return stream;
		},
	});

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd,
		resourceLoader,
		modelRegistry,
	});

	const context: RuntimeSessionContext = {
		tempDir,
		systemPromptPath,
		session,
		sessionManager,
		resourceLoader,
		modelRegistry,
	};
	contexts.push(context);
	return context;
}

async function seedPendingProposal(context: RuntimeSessionContext): Promise<void> {
	await context.session.prompt("seed pending proposal");
	expect(context.sessionManager.getPendingPromptSourceProposal()).toBeDefined();
}

describe("prompt proposal runtime lifecycle", () => {
	afterEach(() => {
		for (const context of contexts.splice(0, contexts.length)) {
			context.session.dispose();
			rmSync(context.tempDir, { recursive: true, force: true });
		}
	});

	it("keeps pending proposals session-local and does not auto-apply runtime overrides", async () => {
		const context = await createRuntimeSession("Approved project prompt");
		const basePrompt = context.session.systemPrompt;

		await context.session.prompt("hello");
		await context.session.prompt("hello again");

		expect(context.session.systemPrompt).toBe(basePrompt);
		expect(context.sessionManager.getPromptSourceProposals()).toHaveLength(1);
		expect(context.sessionManager.getPendingPromptSourceProposal()?.status).toBe("pending");
		expect(readFileSync(context.systemPromptPath, "utf8")).toBe("Approved project prompt");
	});

	it("approves runtime-generated proposal using source-safe prompt content", async () => {
		const context = await createRuntimeSession("Approved project prompt");

		await context.session.prompt("generate pending proposal");

		const pendingProposal = context.sessionManager.getPendingPromptSourceProposal();
		expect(pendingProposal).toBeDefined();
		expect(pendingProposal?.proposedContent).toBe("Approved project prompt\n\nRuntime proposal from extension");

		context.session.approvePromptSourceProposal(pendingProposal!);

		const persisted = readFileSync(context.systemPromptPath, "utf8");
		expect(persisted).toBe("Approved project prompt\n\nRuntime proposal from extension");
		expect(persisted).not.toContain("Current date and time:");
		expect(persisted).not.toContain("Current working directory:");
	});

	it("invalidates stale pending proposals when prompt source changes on reload", async () => {
		const context = await createRuntimeSession("Approved prompt v1");
		await seedPendingProposal(context);

		writeFileSync(context.systemPromptPath, "Approved prompt v2");
		await context.session.reload();

		const proposals = context.sessionManager.getPromptSourceProposals();
		expect(context.sessionManager.getPendingPromptSourceProposal()).toBeUndefined();
		expect(proposals).toHaveLength(2);
		expect(proposals[1]?.status).toBe("rejected");
		expect(proposals[1]?.rationale).toContain("Invalidated:");
	});

	it("invalidates stale pending proposals on tool-set changes", async () => {
		const context = await createRuntimeSession("Approved prompt");
		await seedPendingProposal(context);

		context.session.setActiveToolsByName(["read"]);

		const proposals = context.sessionManager.getPromptSourceProposals();
		expect(context.sessionManager.getPendingPromptSourceProposal()).toBeUndefined();
		expect(proposals).toHaveLength(2);
		expect(proposals[1]?.status).toBe("rejected");
		expect(proposals[1]?.rationale).toContain("Invalidated: tool-set change");
	});

	it("invalidates stale pending proposals on model switches", async () => {
		const context = await createRuntimeSession("Approved prompt");
		await seedPendingProposal(context);

		const available = await context.modelRegistry.getAvailable();
		const currentModel = context.session.model;
		const nextModel = available.find((model) => model.id !== currentModel?.id);
		expect(nextModel).toBeDefined();

		await context.session.setModel(nextModel!);

		const proposals = context.sessionManager.getPromptSourceProposals();
		expect(context.sessionManager.getPendingPromptSourceProposal()).toBeUndefined();
		expect(proposals).toHaveLength(2);
		expect(proposals[1]?.status).toBe("rejected");
		expect(proposals[1]?.rationale).toContain("Invalidated: model switch");
	});

	it("invalidates stale pending proposals on session switches", async () => {
		const context = await createRuntimeSession("Approved prompt");

		const otherSession = SessionManager.create(
			context.sessionManager.getCwd(),
			context.sessionManager.getSessionDir(),
		);
		otherSession.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		otherSession.appendMessage(assistantMessage("ok", context.session.model!));
		otherSession.appendPromptSourceProposal({
			baseVersion: 1,
			proposedVersion: 2,
			status: "pending",
			diff: "- old\n+ new",
			rationale: "session switch stale-base test",
			model: "anthropic/claude-sonnet-4-5",
			timestamp: new Date().toISOString(),
		});
		const otherSessionFile = otherSession.getSessionFile();
		expect(otherSessionFile).toBeDefined();

		await context.session.switchSession(otherSessionFile!);

		const proposals = context.sessionManager.getPromptSourceProposals();
		expect(context.sessionManager.getPendingPromptSourceProposal()).toBeUndefined();
		expect(proposals).toHaveLength(2);
		expect(proposals[1]?.status).toBe("rejected");
		expect(proposals[1]?.rationale).toContain("Invalidated: session switch");
	});
});
