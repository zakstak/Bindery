import type { SelectItem } from "@mariozechner/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { PromptSourceProposal } from "../src/core/prompt-source-state.js";
import { PromptReviewSelectorComponent } from "../src/modes/interactive/components/prompt-review-selector.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const PENDING_PROPOSAL: PromptSourceProposal = {
	baseVersion: 2,
	proposedVersion: 3,
	status: "pending",
	diff: "-1 Old line\n+1 New line",
	rationale: "Reduce ambiguity in agent startup behavior.",
	model: "openai/gpt-5",
	timestamp: "2026-03-12T00:00:00.000Z",
};

describe("PromptReviewSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("renders review-only sections and actions", () => {
		const selector = new PromptReviewSelectorComponent(
			{
				canonicalPath: "/tmp/project/.pi/SYSTEM.md",
				canonicalVersion: 2,
				effectivePromptPreview: "You are a coding agent.",
				pendingProposal: PENDING_PROPOSAL,
				approvedProposals: [{ ...PENDING_PROPOSAL, status: "approved" }],
			},
			{
				onAcceptProposal: () => {},
				onRejectProposal: () => {},
				onRollbackToApproved: () => {},
				onCancel: () => {},
			},
		);

		const output = selector.render(140).join("\n");
		expect(output).toContain("Prompt Review");
		expect(output).toContain("Review-only panel");
		expect(output).toContain("Effective Prompt Preview");
		expect(output).toContain("Proposed Diff");
		expect(output).toContain("Rationale");
		expect(output).toContain("Accept proposal");
		expect(output).toContain("Reject proposal");
		expect(output).toContain("Rollback to approved v3");
		expect(output).not.toContain("Open editor");
	});

	test("invokes accept/reject/rollback callbacks via action list", () => {
		const onAcceptProposal = vi.fn();
		const onRejectProposal = vi.fn();
		const onRollbackToApproved = vi.fn();

		const selector = new PromptReviewSelectorComponent(
			{
				canonicalPath: "/tmp/project/.pi/SYSTEM.md",
				canonicalVersion: 2,
				effectivePromptPreview: "Preview",
				pendingProposal: PENDING_PROPOSAL,
				approvedProposals: [{ ...PENDING_PROPOSAL, status: "approved" }],
			},
			{
				onAcceptProposal,
				onRejectProposal,
				onRollbackToApproved,
				onCancel: () => {},
			},
		);

		const actionList = selector.getActionList();
		actionList.onSelect?.({ value: "accept", label: "Accept" } as SelectItem);
		actionList.onSelect?.({ value: "reject", label: "Reject" } as SelectItem);
		actionList.onSelect?.({ value: "rollback:3", label: "Rollback" } as SelectItem);

		expect(onAcceptProposal).toHaveBeenCalledTimes(1);
		expect(onAcceptProposal).toHaveBeenCalledWith(PENDING_PROPOSAL);
		expect(onRejectProposal).toHaveBeenCalledTimes(1);
		expect(onRejectProposal).toHaveBeenCalledWith(PENDING_PROPOSAL);
		expect(onRollbackToApproved).toHaveBeenCalledTimes(1);
	});
});

describe("InteractiveMode /prompt-review command", () => {
	test("opens prompt review selector and clears editor", async () => {
		const fakeThis: any = {
			defaultEditor: {},
			editor: {
				setText: vi.fn(),
				addToHistory: vi.fn(),
			},
			showPromptReviewSelector: vi.fn(),
		};

		(InteractiveMode as any).prototype.setupEditorSubmitHandler.call(fakeThis);
		await fakeThis.defaultEditor.onSubmit("/prompt-review");

		expect(fakeThis.showPromptReviewSelector).toHaveBeenCalledTimes(1);
		expect(fakeThis.editor.setText).toHaveBeenCalledWith("");
	});
});
