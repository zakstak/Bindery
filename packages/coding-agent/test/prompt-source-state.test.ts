import { describe, expect, it } from "vitest";
import {
	buildPromptSourceState,
	createPromptSourceProposalEntryData,
	getPendingPromptSourceProposal,
	listPromptSourceProposals,
	PROMPT_SOURCE_PROPOSAL_CUSTOM_TYPE,
	type PromptSourceProposal,
} from "../src/core/prompt-source-state.js";
import { SessionManager } from "../src/core/session-manager.js";

function proposal(overrides: Partial<PromptSourceProposal> = {}): PromptSourceProposal {
	return {
		baseVersion: 1,
		proposedVersion: 2,
		status: "pending",
		diff: "- old\n+ new",
		rationale: "Improve safety constraints",
		model: "openai/gpt-5",
		timestamp: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

describe("prompt-source-state", () => {
	it("uses .pi/SYSTEM.md as canonical source path", () => {
		const state = buildPromptSourceState({
			cwd: "/repo/workspace",
			canonicalContent: "approved prompt",
			canonicalVersion: 3,
		});

		expect(state.canonical.path).toBe("/repo/workspace/.pi/SYSTEM.md");
		expect(state.canonical.content).toBe("approved prompt");
		expect(state.canonical.version).toBe(3);
	});

	it("treats effective prompt as derived preview only", () => {
		const base = buildPromptSourceState({
			cwd: "/repo/workspace",
			canonicalContent: "approved prompt",
			canonicalVersion: 4,
			effectivePromptPreview: "preview with date A cwd A",
		});

		const churned = buildPromptSourceState({
			cwd: "/repo/workspace",
			canonicalContent: "approved prompt",
			canonicalVersion: 4,
			effectivePromptPreview: "preview with date B cwd B",
		});

		expect(base.canonical).toEqual(churned.canonical);
		expect(base.effectivePromptPreview).not.toBe(churned.effectivePromptPreview);
	});

	it("stores proposal metadata with required fields", () => {
		const pending = proposal();
		const data = createPromptSourceProposalEntryData(pending);

		expect(data.proposal.baseVersion).toBe(1);
		expect(data.proposal.proposedVersion).toBe(2);
		expect(data.proposal.status).toBe("pending");
		expect(data.proposal.diff).toContain("new");
		expect(data.proposal.rationale).toContain("safety");
		expect(data.proposal.model).toBe("openai/gpt-5");
		expect(data.proposal.timestamp).toBe("2026-01-01T00:00:00.000Z");
	});

	it("represents proposals as append-only custom session entries", () => {
		const entries = [
			{
				type: "custom",
				customType: PROMPT_SOURCE_PROPOSAL_CUSTOM_TYPE,
				data: createPromptSourceProposalEntryData(proposal()),
			},
			{
				type: "custom",
				customType: PROMPT_SOURCE_PROPOSAL_CUSTOM_TYPE,
				data: createPromptSourceProposalEntryData(proposal({ status: "approved" })),
			},
			{ type: "custom", customType: "other_state", data: { anything: true } },
		] as const;

		const proposals = listPromptSourceProposals(entries);
		expect(proposals).toHaveLength(2);
		expect(proposals[0].status).toBe("pending");
		expect(proposals[1].status).toBe("approved");
	});

	it("tracks pending proposal from append-only status entries", () => {
		const entries = [
			{
				type: "custom",
				customType: PROMPT_SOURCE_PROPOSAL_CUSTOM_TYPE,
				data: createPromptSourceProposalEntryData(proposal()),
			},
			{
				type: "custom",
				customType: PROMPT_SOURCE_PROPOSAL_CUSTOM_TYPE,
				data: createPromptSourceProposalEntryData(proposal({ proposedVersion: 3 })),
			},
			{
				type: "custom",
				customType: PROMPT_SOURCE_PROPOSAL_CUSTOM_TYPE,
				data: createPromptSourceProposalEntryData(proposal({ proposedVersion: 3, status: "rejected" })),
			},
		] as const;

		const pending = getPendingPromptSourceProposal(entries);
		expect(pending?.proposedVersion).toBe(2);
		expect(pending?.status).toBe("pending");
	});

	it("enforces one pending proposal per session via helper APIs", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "hi", timestamp: 1 });

		session.appendPromptSourceProposal(proposal());
		expect(session.getPendingPromptSourceProposal()?.proposedVersion).toBe(2);

		expect(() => {
			session.appendPromptSourceProposal(proposal({ proposedVersion: 3 }));
		}).toThrow("still pending");

		session.appendPromptSourceProposal(proposal({ status: "approved" }));
		session.appendPromptSourceProposal(proposal({ baseVersion: 2, proposedVersion: 3, status: "pending" }));

		expect(session.getPendingPromptSourceProposal()?.proposedVersion).toBe(3);
		expect(session.getPromptSourceProposals()).toHaveLength(3);
	});
});
