import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getModel,
	type Model,
} from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import type { PromptSourceProposal } from "../src/core/prompt-source-state.js";
import { DefaultResourceLoader, getProjectSystemPromptPath } from "../src/core/resource-loader.js";
import type { SessionMessageEntry } from "../src/core/session-manager.js";
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
	const tempDir = join(tmpdir(), `pi-prompt-history-approval-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

	const context: Context = { tempDir, cwd, session, sessionManager };
	contexts.push(context);
	return context;
}

function proposal(overrides: Partial<PromptSourceProposal> = {}): PromptSourceProposal {
	return {
		baseVersion: 1,
		proposedVersion: 2,
		status: "pending",
		diff: "- old\n+ new",
		rationale: "update canonical prompt source",
		model: "anthropic/claude-sonnet-4-5",
		timestamp: new Date().toISOString(),
		proposedContent: "approved prompt v2",
		...overrides,
	};
}

describe("prompt history approval persistence", () => {
	afterEach(() => {
		for (const context of contexts.splice(0, contexts.length)) {
			context.session.dispose();
			rmSync(context.tempDir, { recursive: true, force: true });
		}
	});

	it("persists approved proposal source content to .pi/SYSTEM.md", async () => {
		const context = await createContext("approved prompt v1");
		const pending = proposal();
		context.sessionManager.appendPromptSourceProposal(pending);

		const result = context.session.approvePromptSourceProposal(pending);

		expect(result.path).toBe(getProjectSystemPromptPath(context.cwd));
		expect(readFileSync(result.path, "utf8")).toBe("approved prompt v2");
		const proposals = context.sessionManager.getPromptSourceProposals();
		expect(proposals).toHaveLength(2);
		expect(proposals[0]?.status).toBe("pending");
		expect(proposals[1]?.status).toBe("approved");
		expect(proposals[1]?.proposedContent).toBe("approved prompt v2");
	});

	it("appends rejection audit event without mutating approved source", async () => {
		const context = await createContext("approved prompt v1");
		const pending = proposal({ proposedContent: "candidate prompt v2" });
		context.sessionManager.appendPromptSourceProposal(pending);

		context.session.rejectPromptSourceProposal(pending);

		expect(readFileSync(getProjectSystemPromptPath(context.cwd), "utf8")).toBe("approved prompt v1");
		const proposals = context.sessionManager.getPromptSourceProposals();
		expect(proposals).toHaveLength(2);
		expect(proposals[0]?.status).toBe("pending");
		expect(proposals[1]?.status).toBe("rejected");
		expect(proposals[1]?.proposedContent).toBe("candidate prompt v2");
	});

	it("rolls back to selected approved history and records new approved version event", async () => {
		const context = await createContext("approved prompt v3");
		const approvedV2 = proposal({ status: "approved", proposedVersion: 2, proposedContent: "approved prompt v2" });
		const approvedV3 = proposal({
			status: "approved",
			baseVersion: 2,
			proposedVersion: 3,
			proposedContent: "approved prompt v3",
		});
		context.sessionManager.appendPromptSourceProposal(approvedV2);
		context.sessionManager.appendPromptSourceProposal(approvedV3);

		const before = context.sessionManager.getPromptSourceProposals();
		const result = context.session.rollbackPromptSourceProposal(approvedV2);
		const proposals = context.sessionManager.getPromptSourceProposals();

		expect(readFileSync(getProjectSystemPromptPath(context.cwd), "utf8")).toBe("approved prompt v2");
		expect(proposals).toHaveLength(before.length + 2);
		expect(proposals[0]).toEqual(approvedV2);
		expect(proposals[1]).toEqual(approvedV3);

		const rollbackAudit = proposals[2];
		expect(rollbackAudit?.status).toBe("rolled_back");
		expect(rollbackAudit?.rollbackTargetVersion).toBe(2);
		expect(rollbackAudit?.proposedVersion).toBeGreaterThan(3);

		const rollbackApproval = proposals[3];
		expect(rollbackApproval?.status).toBe("approved");
		expect(rollbackApproval?.proposedVersion).toBe(rollbackAudit?.proposedVersion);
		expect(rollbackApproval?.proposedContent).toBe("approved prompt v2");
		expect(result.proposal.proposedVersion).toBe(rollbackApproval?.proposedVersion);
	});

	it("retains prompt proposal history after tree navigation and reload", async () => {
		const context = await createContext("approved prompt v1");
		await context.session.prompt("persist history");
		await context.session.agent.waitForIdle();

		const pendingProposal = proposal();
		context.sessionManager.appendPromptSourceProposal(pendingProposal);
		context.session.approvePromptSourceProposal(pendingProposal);

		const formatProposal = (proposal: PromptSourceProposal): string =>
			`${proposal.status}:${proposal.proposedVersion}`;
		const proposalHistorySignature = context.sessionManager.getPromptSourceProposals().map(formatProposal);

		const userMessageEntry = context.sessionManager
			.getEntries()
			.find((entry): entry is SessionMessageEntry => entry.type === "message" && entry.message.role === "user");
		expect(userMessageEntry).toBeDefined();

		await context.session.navigateTree(userMessageEntry!.id, { summarize: false });

		const afterNavigationSignature = context.sessionManager.getPromptSourceProposals().map(formatProposal);
		expect(afterNavigationSignature).toEqual(proposalHistorySignature);

		const sessionFile = context.sessionManager.getSessionFile();
		expect(sessionFile).toBeDefined();
		const reopenedManager = SessionManager.open(sessionFile!, context.sessionManager.getSessionDir());
		const reopenedProposals = reopenedManager.getPromptSourceProposals();
		const reopenedSignature = reopenedProposals.map(formatProposal);
		expect(reopenedSignature).toEqual(proposalHistorySignature);
		const reopenedApproved = reopenedProposals.find((proposal) => proposal.status === "approved");
		expect(reopenedApproved?.proposedContent).toBe("approved prompt v2");
	});
});
