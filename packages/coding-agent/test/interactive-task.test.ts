import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

describe("InteractiveMode task commands", () => {
	test("routes /task to the task handler and clears editor", async () => {
		const fakeThis: any = {
			defaultEditor: {},
			editor: {
				setText: vi.fn(),
				addToHistory: vi.fn(),
			},
			handleTaskCommand: vi.fn(),
		};

		(InteractiveMode as any).prototype.setupEditorSubmitHandler.call(fakeThis);
		await fakeThis.defaultEditor.onSubmit("/task implement onboarding fix");

		expect(fakeThis.handleTaskCommand).toHaveBeenCalledTimes(1);
		expect(fakeThis.handleTaskCommand).toHaveBeenCalledWith("/task implement onboarding fix");
		expect(fakeThis.editor.setText).toHaveBeenCalledWith("");
	});

	test("routes /task-done to the completion handler and clears editor", async () => {
		const fakeThis: any = {
			defaultEditor: {},
			editor: {
				setText: vi.fn(),
				addToHistory: vi.fn(),
			},
			handleTaskDoneCommand: vi.fn(),
		};

		(InteractiveMode as any).prototype.setupEditorSubmitHandler.call(fakeThis);
		await fakeThis.defaultEditor.onSubmit("/task-done shipped the onboarding fix");

		expect(fakeThis.handleTaskDoneCommand).toHaveBeenCalledTimes(1);
		expect(fakeThis.handleTaskDoneCommand).toHaveBeenCalledWith("/task-done shipped the onboarding fix");
		expect(fakeThis.editor.setText).toHaveBeenCalledWith("");
	});

	test("resumes the parent session view after /task-done succeeds", async () => {
		const clearChat = vi.fn();
		const clearPending = vi.fn();
		const renderInitialMessages = vi.fn();
		const showStatus = vi.fn();
		const requestRender = vi.fn();
		const completeTaskSessionAndResumeParent = vi.fn().mockResolvedValue({
			result: { taskId: "12345678-90ab-cdef-1234-567890abcdef" },
			resumedParent: true,
		});

		const fakeThis: any = {
			session: {
				isStreaming: false,
				isCompacting: false,
				completeTaskSessionAndResumeParent,
			},
			chatContainer: { clear: clearChat },
			pendingMessagesContainer: { clear: clearPending },
			compactionQueuedMessages: [{ text: "queued", mode: "followUp" }],
			streamingComponent: { existing: true },
			streamingMessage: { existing: true },
			pendingTools: new Map([["tool", {}]]),
			renderInitialMessages,
			showStatus,
			showWarning: vi.fn(),
			showError: vi.fn(),
			ui: { requestRender },
		};

		await (InteractiveMode as any).prototype.handleTaskDoneCommand.call(
			fakeThis,
			"/task-done wrapped up the onboarding fix",
		);

		expect(completeTaskSessionAndResumeParent).toHaveBeenCalledWith({
			summary: "wrapped up the onboarding fix",
		});
		expect(clearChat).toHaveBeenCalledTimes(1);
		expect(clearPending).toHaveBeenCalledTimes(1);
		expect(fakeThis.compactionQueuedMessages).toEqual([]);
		expect(fakeThis.streamingComponent).toBeUndefined();
		expect(fakeThis.streamingMessage).toBeUndefined();
		expect(fakeThis.pendingTools.size).toBe(0);
		expect(renderInitialMessages).toHaveBeenCalledTimes(1);
		expect(showStatus).toHaveBeenCalledWith("Recorded task result for 12345678 and resumed parent session");
		expect(requestRender).toHaveBeenCalledTimes(1);
	});
});
