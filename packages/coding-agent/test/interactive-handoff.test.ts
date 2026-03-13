import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

describe("InteractiveMode /handoff command", () => {
	test("opens handoff flow and clears editor", async () => {
		const fakeThis: any = {
			defaultEditor: {},
			editor: {
				setText: vi.fn(),
				addToHistory: vi.fn(),
			},
			handleHandoffCommand: vi.fn(),
		};

		(InteractiveMode as any).prototype.setupEditorSubmitHandler.call(fakeThis);
		await fakeThis.defaultEditor.onSubmit("/handoff resume with QA first");

		expect(fakeThis.handleHandoffCommand).toHaveBeenCalledTimes(1);
		expect(fakeThis.handleHandoffCommand).toHaveBeenCalledWith("/handoff resume with QA first");
		expect(fakeThis.editor.setText).toHaveBeenCalledWith("");
	});
});
