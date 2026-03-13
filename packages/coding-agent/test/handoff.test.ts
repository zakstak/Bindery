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
import { buildHandoffMarkdown, collectHandoffRelevantFiles, createHandoffDocument } from "../src/core/handoff.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { DefaultResourceLoader, getProjectSystemPromptPath } from "../src/core/resource-loader.js";
import type { BranchSummaryEntry, CompactionEntry, SessionEntry } from "../src/core/session-manager.js";
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

interface Context {
	tempDir: string;
	cwd: string;
	session: AgentSession;
	sessionManager: SessionManager;
}

const contexts: Context[] = [];

async function createContext(initialPrompt: string): Promise<Context> {
	const tempDir = join(tmpdir(), `pi-handoff-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const agentDir = join(tempDir, "agent");
	const cwd = join(tempDir, "project");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(getProjectSystemPromptPath(cwd), initialPrompt);

	const settingsManager = SettingsManager.create(cwd, agentDir);
	const sessionManager = SessionManager.create(cwd);
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

describe("handoff helpers", () => {
	afterEach(() => {
		for (const context of contexts.splice(0, contexts.length)) {
			context.session.dispose();
			rmSync(context.tempDir, { recursive: true, force: true });
		}
	});

	it("collects relevant files from compaction and branch summary details", () => {
		const entries: SessionEntry[] = [
			{
				type: "compaction",
				id: "cmp-1",
				parentId: null,
				timestamp: new Date().toISOString(),
				summary: "summary",
				firstKeptEntryId: "msg-1",
				tokensBefore: 10,
				details: { readFiles: ["a.ts"], modifiedFiles: ["b.ts"] },
			} satisfies CompactionEntry,
			{
				type: "branch_summary",
				id: "sum-1",
				parentId: "cmp-1",
				timestamp: new Date().toISOString(),
				summary: "branch",
				fromId: "msg-2",
				details: { readFiles: ["b.ts"], modifiedFiles: ["c.ts"] },
			} satisfies BranchSummaryEntry<{ readFiles: string[]; modifiedFiles: string[] }>,
		];

		expect(collectHandoffRelevantFiles(entries)).toEqual(["a.ts", "b.ts", "c.ts"]);
	});

	it("builds structured handoff document markdown", () => {
		const document = createHandoffDocument({
			sessionId: "session-1",
			cwd: "/tmp/project",
			model: "anthropic/claude-sonnet-4-5",
			latestUserGoal: "Finish the onboarding refactor",
			latestAssistantText: "Validated the current runtime seams.",
			relevantFiles: ["src/app.ts", "src/onboarding.ts"],
			notes: "Resume with the task contract next.",
		});

		const markdown = buildHandoffMarkdown(document);
		expect(markdown).toContain("## Goal");
		expect(markdown).toContain("Finish the onboarding refactor");
		expect(markdown).toContain("## Relevant Files");
		expect(markdown).toContain("src/app.ts");
		expect(markdown).toContain("## Next Step");
		expect(markdown).toContain("Resume with the task contract next.");
	});

	it("creates a new session seeded from a persisted handoff artifact", async () => {
		const context = await createContext("You are pi.");
		context.sessionManager.appendSessionInfo("Self-hosting");
		await context.session.prompt("Finish the handoff system.");
		await context.session.agent.waitForIdle();

		const previousSessionFile = context.session.sessionFile;
		const result = await context.session.handoffToNewSession({
			notes: "Resume by validating the handoff artifact and continuing the implementation.",
		});

		expect(result.cancelled).toBe(false);
		expect(result.document.goal).toContain("Finish the handoff system");
		expect(result.previousSessionFile).toBe(previousSessionFile);
		expect(result.nextSessionFile).toBeDefined();
		expect(result.nextSessionFile).not.toBe(previousSessionFile);

		const previousEntries = readFileSync(previousSessionFile!, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const handoffEntry = previousEntries.find(
			(entry: { type?: string; customType?: string }) =>
				entry.type === "custom" && entry.customType === "handoff_document",
		);
		expect(handoffEntry).toBeDefined();

		const newEntries = context.sessionManager.getEntries();
		const handoffMessage = newEntries.find(
			(entry: { type: string; customType?: string }) =>
				entry.type === "custom_message" && entry.customType === "handoff_context",
		) as { content?: string; details?: { goal?: string } } | undefined;
		expect(handoffMessage).toBeDefined();
		expect(typeof handoffMessage?.content).toBe("string");
		expect(handoffMessage?.content).toContain("## Goal");
		expect(handoffMessage?.details?.goal).toContain("Finish the handoff system");
	});
});
