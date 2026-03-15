import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.js";

const rpcInputHandlers: Array<(line: string) => void> = [];

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: (_stream: NodeJS.ReadStream, onLine: (line: string) => void) => {
		rpcInputHandlers.push(onLine);
		return () => {};
	},
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function parseRpcWrites(writeSpy: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> {
	const lines = writeSpy.mock.calls
		.map(([chunk]) => String(chunk))
		.join("")
		.split("\n")
		.filter((line) => line.length > 0);
	return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function createRpcSession(): AgentSession {
	const models = [
		{
			provider: "mock",
			id: "model-a",
			name: "Model A",
			contextWindow: 1234,
			reasoning: false,
		},
		{
			provider: "mock",
			id: "model-b",
			name: "Model B",
			contextWindow: 4321,
			reasoning: true,
		},
	];
	let currentModel = models[0];

	const session = {
		agent: { waitForIdle: async () => {} },
		bindExtensions: async () => {},
		subscribe: () => () => {},
		prompt: vi.fn(async () => {}),
		abort: vi.fn(async () => {}),
		startTaskSession: vi.fn(async ({ goal }: { goal: string }) => ({
			cancelled: false,
			packet: { taskId: `task-${goal}`, goal },
			previousSessionFile: "/tmp/parent.jsonl",
			nextSessionFile: "/tmp/child.jsonl",
		})),
		completeTaskSession: vi.fn(({ summary }: { summary: string }) => ({
			taskId: `task-${summary}`,
			parentSessionFile: "/tmp/parent.jsonl",
		})),
		completeTaskSessionAndResumeParent: vi.fn(async ({ summary }: { summary: string }) => ({
			result: { taskId: `task-${summary}`, parentSessionFile: "/tmp/parent.jsonl" },
			resumedParent: true,
			parentSessionFile: "/tmp/parent.jsonl",
		})),
		switchSession: vi.fn(async () => true),
		fork: vi.fn(async (entryId: string) => ({
			selectedText: `forked:${entryId}`,
			cancelled: false,
		})),
		getUserMessagesForForking: vi.fn(() => [{ entryId: "u1", text: "first" }]),
		modelRegistry: { getAvailable: async () => models },
		setModel: vi.fn(async (model: (typeof models)[number]) => {
			currentModel = model;
		}),
		get model() {
			return currentModel;
		},
		thinkingLevel: "minimal",
		isStreaming: false,
		isCompacting: false,
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
		sessionFile: "/tmp/session.jsonl",
		sessionId: "session-1",
		sessionName: "operator-contract",
		autoCompactionEnabled: true,
		messages: [],
		pendingMessageCount: 0,
	} as unknown as AgentSession;

	return session;
}

function findResponse(
	responses: Array<Record<string, unknown>>,
	id: string,
): Extract<Record<string, unknown>, { type: "response" }> {
	const response = responses.find((entry) => entry.type === "response" && entry.id === id);
	if (!response) {
		throw new Error(`Missing response for id ${id}`);
	}
	return response as Extract<Record<string, unknown>, { type: "response" }>;
}

describe("RPC operator contract", () => {
	let writeSpy: { mock: { calls: unknown[][] } };

	beforeEach(() => {
		rpcInputHandlers.length = 0;
		writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("supports the approved operator-flow command subset with response envelopes", async () => {
		const session = createRpcSession();
		void runRpcMode(session);
		await flush();

		rpcInputHandlers[0](JSON.stringify({ id: "s1", type: "get_state" }));
		rpcInputHandlers[0](JSON.stringify({ id: "s2", type: "get_available_models" }));
		rpcInputHandlers[0](JSON.stringify({ id: "s3", type: "set_model", provider: "mock", modelId: "model-b" }));
		rpcInputHandlers[0](JSON.stringify({ id: "s4", type: "prompt", message: "do work" }));
		rpcInputHandlers[0](JSON.stringify({ id: "s5", type: "abort" }));
		rpcInputHandlers[0](JSON.stringify({ id: "s6", type: "start_task_session", goal: "ship" }));
		rpcInputHandlers[0](JSON.stringify({ id: "s7", type: "complete_task_session", summary: "done" }));
		rpcInputHandlers[0](JSON.stringify({ id: "s8", type: "switch_session", sessionPath: "/tmp/next.jsonl" }));
		rpcInputHandlers[0](JSON.stringify({ id: "s9", type: "fork", entryId: "u1" }));
		rpcInputHandlers[0](JSON.stringify({ id: "s10", type: "get_fork_messages" }));
		await flush();

		const responses = parseRpcWrites(writeSpy);

		expect(findResponse(responses, "s1")).toMatchObject({
			id: "s1",
			type: "response",
			command: "get_state",
			success: true,
		});
		expect(findResponse(responses, "s2")).toMatchObject({
			id: "s2",
			type: "response",
			command: "get_available_models",
			success: true,
			data: { models: modelsLike("model-a", "model-b") },
		});
		expect(findResponse(responses, "s3")).toMatchObject({
			id: "s3",
			type: "response",
			command: "set_model",
			success: true,
			data: { provider: "mock", id: "model-b" },
		});
		expect(findResponse(responses, "s4")).toMatchObject({
			id: "s4",
			type: "response",
			command: "prompt",
			success: true,
		});
		expect(findResponse(responses, "s5")).toMatchObject({
			id: "s5",
			type: "response",
			command: "abort",
			success: true,
		});
		expect(findResponse(responses, "s6")).toMatchObject({
			id: "s6",
			type: "response",
			command: "start_task_session",
			success: true,
			data: {
				cancelled: false,
				packet: { taskId: "task-ship", goal: "ship" },
			},
		});
		expect(findResponse(responses, "s7")).toMatchObject({
			id: "s7",
			type: "response",
			command: "complete_task_session",
			success: true,
			data: {
				result: { taskId: "task-done" },
				resumedParent: true,
			},
		});
		expect(findResponse(responses, "s8")).toMatchObject({
			id: "s8",
			type: "response",
			command: "switch_session",
			success: true,
			data: { cancelled: false },
		});
		expect(findResponse(responses, "s9")).toMatchObject({
			id: "s9",
			type: "response",
			command: "fork",
			success: true,
			data: { text: "forked:u1", cancelled: false },
		});
		expect(findResponse(responses, "s10")).toMatchObject({
			id: "s10",
			type: "response",
			command: "get_fork_messages",
			success: true,
			data: { messages: [{ entryId: "u1", text: "first" }] },
		});
	});

	it("keeps id-correlated errors and continues processing after command failures", async () => {
		const session = createRpcSession();
		void runRpcMode(session);
		await flush();

		rpcInputHandlers[0](JSON.stringify({ id: "bad-model", type: "set_model", provider: "mock", modelId: "missing" }));
		rpcInputHandlers[0](JSON.stringify({ id: "next-ok", type: "get_state" }));
		await flush();

		const responses = parseRpcWrites(writeSpy);
		expect(findResponse(responses, "bad-model")).toMatchObject({
			id: "bad-model",
			type: "response",
			command: "set_model",
			success: false,
		});
		expect(findResponse(responses, "next-ok")).toMatchObject({
			id: "next-ok",
			type: "response",
			command: "get_state",
			success: true,
		});
	});

	it("returns parse errors for malformed payloads and keeps later commands healthy", async () => {
		const session = createRpcSession();
		void runRpcMode(session);
		await flush();

		rpcInputHandlers[0]("{");
		rpcInputHandlers[0](JSON.stringify({ id: "after-parse", type: "get_state" }));
		await flush();

		const responses = parseRpcWrites(writeSpy);
		expect(responses).toContainEqual(
			expect.objectContaining({
				type: "response",
				command: "parse",
				success: false,
			}),
		);
		expect(findResponse(responses, "after-parse")).toMatchObject({
			id: "after-parse",
			type: "response",
			command: "get_state",
			success: true,
		});
	});

	it("throws deterministic errors for unsupported extension UI hooks in rpc mode", async () => {
		const session = createRpcSession();
		let capturedUI: unknown;
		session.bindExtensions = vi.fn(async ({ uiContext }: { uiContext?: unknown }) => {
			capturedUI = uiContext;
		});

		void runRpcMode(session);
		await flush();

		expect(capturedUI).toBeDefined();
		const ui = capturedUI as {
			setFooter: (factory: unknown) => void;
			setWidget: (key: string, content: unknown) => void;
		};

		expect(() => ui.setFooter(undefined)).toThrowError('Extension UI method "setFooter" is unsupported in rpc mode.');
		expect(() => ui.setWidget("widget", () => "component")).toThrowError(
			'Extension UI method "setWidget" is unsupported in rpc mode.',
		);
	});
});

function modelsLike(...ids: string[]) {
	return ids.map((id, index) => ({
		provider: "mock",
		id,
		name: `Model ${String.fromCharCode(65 + index)}`,
		contextWindow: index === 0 ? 1234 : 4321,
		reasoning: index !== 0,
	}));
}
