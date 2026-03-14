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
		newSession: async () => true,
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

describe("/prompt-review mode safety", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("blocks /prompt-review in print mode without calling the model", async () => {
		const promptSpy = vi.fn();
		const session = createPrintSession(promptSpy);
		const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const previousExitCode = process.exitCode;

		try {
			process.exitCode = 0;
			await runPrintMode(session, {
				mode: "text",
				initialMessage: "/prompt-review",
			});

			expect(promptSpy).not.toHaveBeenCalled();
			expect(stderrSpy).toHaveBeenCalledWith(
				"The /prompt-review command is only available in Bindery web interactive sessions.",
			);
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

		it("rejects /prompt-review prompt commands without model execution", async () => {
			const session = createRpcSession();
			void runRpcMode(session);
			await new Promise((resolve) => setTimeout(resolve, 0));

			rpcInputHandlers[0](JSON.stringify({ id: "1", type: "prompt", message: "/prompt-review" }));
			await new Promise((resolve) => setTimeout(resolve, 0));

			const responses = parseRpcWrites(writeSpy);
			expect(responses).toContainEqual({
				id: "1",
				type: "response",
				command: "prompt",
				success: false,
				error: "The /prompt-review command is only available in Bindery web interactive sessions.",
			});
			expect(session.prompt).not.toHaveBeenCalled();
		});

		it("rejects /prompt-review steer and follow_up commands", async () => {
			const session = createRpcSession();
			void runRpcMode(session);
			await new Promise((resolve) => setTimeout(resolve, 0));

			rpcInputHandlers[0](JSON.stringify({ id: "2", type: "steer", message: "/prompt-review" }));
			rpcInputHandlers[0](JSON.stringify({ id: "3", type: "follow_up", message: "/prompt-review" }));
			await new Promise((resolve) => setTimeout(resolve, 0));

			const responses = parseRpcWrites(writeSpy);
			expect(responses).toContainEqual({
				id: "2",
				type: "response",
				command: "steer",
				success: false,
				error: "The /prompt-review command is only available in Bindery web interactive sessions.",
			});
			expect(responses).toContainEqual({
				id: "3",
				type: "response",
				command: "follow_up",
				success: false,
				error: "The /prompt-review command is only available in Bindery web interactive sessions.",
			});
			expect(session.steer).not.toHaveBeenCalled();
			expect(session.followUp).not.toHaveBeenCalled();
		});
	});
});
