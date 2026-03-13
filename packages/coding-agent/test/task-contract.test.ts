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
import { DefaultResourceLoader, getProjectSystemPromptPath } from "../src/core/resource-loader.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import {
	buildTaskPacketMarkdown,
	buildTaskResultMarkdown,
	createTaskPacket,
	getLatestTaskPacket,
	getLatestTaskResult,
	TASK_CONTEXT_CUSTOM_TYPE,
	TASK_PACKET_CUSTOM_TYPE,
	TASK_RESULT_CONTEXT_CUSTOM_TYPE,
	TASK_RESULT_CUSTOM_TYPE,
} from "../src/core/task-contract.js";

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

interface Context {
	tempDir: string;
	cwd: string;
	session: AgentSession;
	sessionManager: SessionManager;
}

const contexts: Context[] = [];

async function createContext(initialPrompt: string): Promise<Context> {
	const tempDir = join(tmpdir(), `pi-task-contract-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const agentDir = join(tempDir, "agent");
	const sessionDir = join(tempDir, "sessions");
	const cwd = join(tempDir, "project");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(getProjectSystemPromptPath(cwd), initialPrompt);

	const settingsManager = SettingsManager.create(cwd, agentDir);
	const sessionManager = SessionManager.create(cwd, sessionDir);
	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.json"));

	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
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
				stream.push({ type: "done", reason: "stop", message: assistantMessage("done", model) });
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

	const context: Context = { tempDir, cwd, session, sessionManager };
	contexts.push(context);
	return context;
}

describe("task contract helpers", () => {
	afterEach(() => {
		for (const context of contexts.splice(0, contexts.length)) {
			context.session.dispose();
			rmSync(context.tempDir, { recursive: true, force: true });
		}
	});

	it("builds a structured task packet markdown contract", () => {
		const packet = createTaskPacket({
			parentSessionId: "parent-1",
			cwd: "/tmp/project",
			goal: "Fix the onboarding regression",
			constraints: ["No refactor"],
			relevantFiles: ["src/onboarding.ts"],
			doneDefinition: "Return one structured result summary.",
		});

		const markdown = buildTaskPacketMarkdown(packet);
		expect(markdown).toContain("## Task Goal");
		expect(markdown).toContain("Fix the onboarding regression");
		expect(markdown).toContain("## Constraints");
		expect(markdown).toContain("No refactor");
		expect(markdown).toContain("## Done Definition");
	});

	it("creates a child session seeded from a task packet", async () => {
		const context = await createContext("You are pi.");
		await context.session.prompt("Prepare the onboarding fix.");
		await context.session.agent.waitForIdle();

		const previousSessionFile = context.session.sessionFile;
		const result = await context.session.startTaskSession({
			goal: "Implement the onboarding fix",
			constraints: ["Keep the diff small"],
		});

		expect(result.cancelled).toBe(false);
		expect(result.packet.goal).toBe("Implement the onboarding fix");
		expect(result.packet.doneDefinition).toContain("structured result summary");
		expect(result.previousSessionFile).toBe(previousSessionFile);
		expect(result.nextSessionFile).toBeDefined();

		const previousEntries = readFileSync(previousSessionFile!, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(getLatestTaskPacket(previousEntries)).toBeDefined();

		const taskContext = context.sessionManager
			.getEntries()
			.find((entry) => entry.type === "custom_message" && entry.customType === TASK_CONTEXT_CUSTOM_TYPE);
		expect(taskContext).toBeDefined();
		if (!taskContext || taskContext.type !== "custom_message") {
			throw new Error("Expected task context custom message");
		}
		expect(typeof taskContext.content).toBe("string");
		expect(String(taskContext.content)).toContain("## Task Goal");
	});

	it("records task result locally and returns it to the parent session", async () => {
		const context = await createContext("You are pi.");
		const taskResult = await context.session.startTaskSession({
			goal: "Ship the onboarding fix",
			constraints: ["Keep verification explicit"],
		});
		const parentSessionFile = taskResult.previousSessionFile!;

		const result = context.session.completeTaskSession({
			summary: "Implemented the fix and verified the flow.",
			nextStep: "Return to the parent session and continue QA.",
		});

		const markdown = buildTaskResultMarkdown(result);
		expect(markdown).toContain("## Task Result");
		expect(markdown).toContain("Implemented the fix and verified the flow.");

		const childEntries = context.sessionManager.getEntries();
		expect(getLatestTaskResult(childEntries)).toBeDefined();
		const parentEntries = readFileSync(parentSessionFile, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(getLatestTaskResult(parentEntries)).toBeDefined();
		const parentResultMessage = parentEntries.find(
			(entry: { type?: string; customType?: string }) =>
				entry.type === "custom_message" && entry.customType === TASK_RESULT_CONTEXT_CUSTOM_TYPE,
		);
		expect(parentResultMessage).toBeDefined();
		expect(String(parentResultMessage?.content)).toContain("## Task Result");
		expect(parentResultMessage?.details?.taskId).toBe(result.taskId);
		expect(
			parentEntries.some(
				(entry: { type?: string; customType?: string }) => entry.customType === TASK_PACKET_CUSTOM_TYPE,
			),
		).toBe(true);
		expect(
			parentEntries.some(
				(entry: { type?: string; customType?: string }) => entry.customType === TASK_RESULT_CUSTOM_TYPE,
			),
		).toBe(true);
	});
});
