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
});
