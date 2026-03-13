import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import { runPrintMode } from "../src/modes/print-mode.js";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.js";

const rpcInputHandlers: Array<(line: string) => void> = [];

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: (_stream: NodeJS.ReadStream, onLine: (line: string) => void) => {
		rpcInputHandlers.push(onLine);
		return () => {};
	},
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

function createPrintSession(promptSpy: ReturnType<typeof vi.fn>): AgentSession {
	return {
		sessionManager: { getHeader: () => undefined },
		bindExtensions: async () => {},
		subscribe: () => () => {},
		prompt: promptSpy,
		state: { messages: [] },
	} as unknown as AgentSession;
}

function createRpcSession(): AgentSession {
	return {
		agent: { waitForIdle: async () => {} },
		bindExtensions: async () => {},
		subscribe: () => () => {},
		prompt: vi.fn(),
		steer: vi.fn(),
		followUp: vi.fn(),
		isStreaming: false,
		isCompacting: false,
		newSession: async () => true,
		startTaskSession: vi.fn(async ({ goal }: { goal: string }) => ({
			cancelled: false,
			packet: { taskId: `task-${goal}` },
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
		fork: async () => ({ selectedText: "", cancelled: false }),
		navigateTree: async () => ({ cancelled: false }),
		switchSession: async () => true,
		reload: async () => {},
		abort: async () => {},
	} as unknown as AgentSession;
}

function parseRpcWrites(writeSpy: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> {
	const lines = writeSpy.mock.calls
		.map(([chunk]) => String(chunk))
		.join("")
		.split("\n")
		.filter((line) => line.length > 0);
	return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("/task mode safety", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("blocks /task and /task-done in print mode without calling the model", async () => {
		const promptSpy = vi.fn();
		const session = createPrintSession(promptSpy);
		const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const previousExitCode = process.exitCode;

		try {
			process.exitCode = 0;
			await runPrintMode(session, {
				mode: "text",
				initialMessage: "/task do the thing",
				messages: ["/task-done finished"],
			});

			expect(promptSpy).not.toHaveBeenCalled();
			expect(stderrSpy).toHaveBeenCalledWith("The /task command is only available in interactive mode.");
			expect(process.exitCode).toBe(1);
		} finally {
			process.exitCode = previousExitCode;
		}
	});

	describe("rpc mode", () => {
		let writeSpy: { mock: { calls: unknown[][] } };

		beforeEach(() => {
			rpcInputHandlers.length = 0;
			writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		});

		it("rejects /task prompt commands without model execution", async () => {
			const session = createRpcSession();
			void runRpcMode(session);
			await new Promise((resolve) => setTimeout(resolve, 0));

			rpcInputHandlers[0](JSON.stringify({ id: "1", type: "prompt", message: "/task do work" }));
			await new Promise((resolve) => setTimeout(resolve, 0));

			const responses = parseRpcWrites(writeSpy);
			expect(responses).toContainEqual({
				id: "1",
				type: "response",
				command: "prompt",
				success: false,
				error: "The /task command is only available in interactive mode.",
			});
			expect(session.prompt).not.toHaveBeenCalled();
		});

		it("rejects /task-done steer and follow_up commands", async () => {
			const session = createRpcSession();
			void runRpcMode(session);
			await new Promise((resolve) => setTimeout(resolve, 0));

			rpcInputHandlers[0](JSON.stringify({ id: "2", type: "steer", message: "/task-done wrapped up" }));
			rpcInputHandlers[0](JSON.stringify({ id: "3", type: "follow_up", message: "/task-done wrapped up" }));
			await new Promise((resolve) => setTimeout(resolve, 0));

			const responses = parseRpcWrites(writeSpy);
			expect(responses).toContainEqual({
				id: "2",
				type: "response",
				command: "steer",
				success: false,
				error: "The /task-done command is only available in interactive mode.",
			});
			expect(responses).toContainEqual({
				id: "3",
				type: "response",
				command: "follow_up",
				success: false,
				error: "The /task-done command is only available in interactive mode.",
			});
			expect(session.steer).not.toHaveBeenCalled();
			expect(session.followUp).not.toHaveBeenCalled();
		});

		it("allows typed start_task_session commands", async () => {
			const session = createRpcSession();
			void runRpcMode(session);
			await new Promise((resolve) => setTimeout(resolve, 0));

			rpcInputHandlers[0](
				JSON.stringify({
					id: "4",
					type: "start_task_session",
					goal: "do work",
					constraints: ["stay focused"],
				}),
			);
			await new Promise((resolve) => setTimeout(resolve, 0));

			const responses = parseRpcWrites(writeSpy);
			expect(responses).toContainEqual({
				id: "4",
				type: "response",
				command: "start_task_session",
				success: true,
				data: {
					cancelled: false,
					packet: { taskId: "task-do work" },
					previousSessionFile: "/tmp/parent.jsonl",
					nextSessionFile: "/tmp/child.jsonl",
				},
			});
			expect(session.startTaskSession).toHaveBeenCalledWith({
				goal: "do work",
				constraints: ["stay focused"],
				doneDefinition: undefined,
				notes: undefined,
			});
		});

		it("uses parent resume by default for typed complete_task_session commands", async () => {
			const session = createRpcSession();
			void runRpcMode(session);
			await new Promise((resolve) => setTimeout(resolve, 0));

			rpcInputHandlers[0](JSON.stringify({ id: "5", type: "complete_task_session", summary: "wrapped up" }));
			await new Promise((resolve) => setTimeout(resolve, 0));

			const responses = parseRpcWrites(writeSpy);
			expect(responses).toContainEqual({
				id: "5",
				type: "response",
				command: "complete_task_session",
				success: true,
				data: {
					result: { taskId: "task-wrapped up", parentSessionFile: "/tmp/parent.jsonl" },
					resumedParent: true,
					parentSessionFile: "/tmp/parent.jsonl",
				},
			});
			expect(session.completeTaskSessionAndResumeParent).toHaveBeenCalledWith({
				summary: "wrapped up",
				openRisks: undefined,
				nextStep: undefined,
				notes: undefined,
			});
			expect(session.completeTaskSession).not.toHaveBeenCalled();
		});

		it("can complete a typed task session without resuming the parent", async () => {
			const session = createRpcSession();
			void runRpcMode(session);
			await new Promise((resolve) => setTimeout(resolve, 0));

			rpcInputHandlers[0](
				JSON.stringify({ id: "6", type: "complete_task_session", summary: "wrapped up", resumeParent: false }),
			);
			await new Promise((resolve) => setTimeout(resolve, 0));

			const responses = parseRpcWrites(writeSpy);
			expect(responses).toContainEqual({
				id: "6",
				type: "response",
				command: "complete_task_session",
				success: true,
				data: {
					result: { taskId: "task-wrapped up", parentSessionFile: "/tmp/parent.jsonl" },
					resumedParent: false,
					parentSessionFile: "/tmp/parent.jsonl",
				},
			});
			expect(session.completeTaskSession).toHaveBeenCalledWith({
				summary: "wrapped up",
				openRisks: undefined,
				nextStep: undefined,
				notes: undefined,
			});
		});
	});
});
