import { getProjectSystemPromptPath } from "./resource-loader.js";

export const PROMPT_SOURCE_PROPOSAL_CUSTOM_TYPE = "prompt_source_proposal";

export type PromptSourceProposalStatus = "pending" | "approved" | "rejected" | "rolled_back";

export interface PromptSourceProposal {
	baseVersion: number;
	proposedVersion: number;
	status: PromptSourceProposalStatus;
	diff: string;
	rationale: string;
	model: string;
	timestamp: string;
	proposedContent?: string;
	rollbackTargetVersion?: number;
}

export interface PromptSourceProposalEntryData {
	proposal: PromptSourceProposal;
}

export interface PromptSourceCanonicalState {
	path: string;
	content: string;
	version: number;
}

export interface PromptSourceState {
	canonical: PromptSourceCanonicalState;
	effectivePromptPreview?: string;
	proposals: PromptSourceProposal[];
	pendingProposal?: PromptSourceProposal;
}

export interface CreatePendingPromptSourceProposalOptions {
	baseVersion: number;
	basePrompt: string;
	proposedPromptSource: string;
	rationale: string;
	model: string;
	previousProposals?: ReadonlyArray<PromptSourceProposal>;
	timestamp?: string;
}

export interface CreateStalePromptSourceProposalOptions {
	pendingProposal: PromptSourceProposal;
	reason: string;
	model: string;
	timestamp?: string;
}

interface SessionCustomEntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

function isPromptSourceProposal(value: unknown): value is PromptSourceProposal {
	if (!value || typeof value !== "object") {
		return false;
	}

	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.baseVersion === "number" &&
		typeof candidate.proposedVersion === "number" &&
		(candidate.status === "pending" ||
			candidate.status === "approved" ||
			candidate.status === "rejected" ||
			candidate.status === "rolled_back") &&
		typeof candidate.diff === "string" &&
		typeof candidate.rationale === "string" &&
		typeof candidate.model === "string" &&
		typeof candidate.timestamp === "string" &&
		(candidate.proposedContent === undefined || typeof candidate.proposedContent === "string") &&
		(candidate.rollbackTargetVersion === undefined || typeof candidate.rollbackTargetVersion === "number")
	);
}

function isPromptSourceProposalEntryData(value: unknown): value is PromptSourceProposalEntryData {
	if (!value || typeof value !== "object") {
		return false;
	}

	const candidate = value as Record<string, unknown>;
	return isPromptSourceProposal(candidate.proposal);
}

export function createPromptSourceProposalEntryData(proposal: PromptSourceProposal): PromptSourceProposalEntryData {
	return { proposal };
}

export function buildPromptSourceDiff(basePrompt: string, proposedPrompt: string): string {
	if (basePrompt === proposedPrompt) {
		return "";
	}

	return `--- approved\n+++ proposed\n@@\n-${basePrompt}\n+${proposedPrompt}`;
}

export function getNextPromptSourceProposalVersion(
	baseVersion: number,
	proposals: ReadonlyArray<PromptSourceProposal>,
): number {
	let maxVersion = baseVersion;
	for (const proposal of proposals) {
		maxVersion = Math.max(maxVersion, proposal.proposedVersion);
	}
	return maxVersion + 1;
}

export function createPendingPromptSourceProposal(
	options: CreatePendingPromptSourceProposalOptions,
): PromptSourceProposal {
	return {
		baseVersion: options.baseVersion,
		proposedVersion: getNextPromptSourceProposalVersion(options.baseVersion, options.previousProposals ?? []),
		status: "pending",
		diff: buildPromptSourceDiff(options.basePrompt, options.proposedPromptSource),
		rationale: options.rationale,
		model: options.model,
		timestamp: options.timestamp ?? new Date().toISOString(),
		proposedContent: options.proposedPromptSource,
	};
}

export function createStalePromptSourceProposal(options: CreateStalePromptSourceProposalOptions): PromptSourceProposal {
	return {
		...options.pendingProposal,
		status: "rejected",
		rationale: `${options.pendingProposal.rationale}\n\nInvalidated: ${options.reason}`,
		model: options.model,
		timestamp: options.timestamp ?? new Date().toISOString(),
	};
}

export function getPromptSourceCanonicalVersion(proposals: ReadonlyArray<PromptSourceProposal>): number {
	let version = 0;
	for (const proposal of proposals) {
		version = Math.max(version, proposal.baseVersion, proposal.proposedVersion);
	}
	return version;
}

export function getApprovedPromptSourceProposals(
	proposals: ReadonlyArray<PromptSourceProposal>,
): PromptSourceProposal[] {
	return proposals
		.filter((proposal) => proposal.status === "approved")
		.sort((a, b) => b.proposedVersion - a.proposedVersion);
}

export function getPromptSourceProposalContent(proposal: PromptSourceProposal): string | undefined {
	if (typeof proposal.proposedContent === "string") {
		return proposal.proposedContent;
	}
	return undefined;
}

export function listPromptSourceProposals(entries: ReadonlyArray<SessionCustomEntryLike>): PromptSourceProposal[] {
	const proposals: PromptSourceProposal[] = [];

	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== PROMPT_SOURCE_PROPOSAL_CUSTOM_TYPE) {
			continue;
		}
		if (!isPromptSourceProposalEntryData(entry.data)) {
			continue;
		}
		proposals.push(entry.data.proposal);
	}

	return proposals;
}

export function getPendingPromptSourceProposal(
	entries: ReadonlyArray<SessionCustomEntryLike>,
): PromptSourceProposal | undefined {
	const pendingByVersion = new Map<number, PromptSourceProposal>();

	for (const proposal of listPromptSourceProposals(entries)) {
		if (proposal.status === "pending") {
			pendingByVersion.set(proposal.proposedVersion, proposal);
			continue;
		}
		pendingByVersion.delete(proposal.proposedVersion);
	}

	if (pendingByVersion.size === 0) {
		return undefined;
	}

	return Array.from(pendingByVersion.values()).sort((a, b) => b.proposedVersion - a.proposedVersion)[0];
}

export function assertNoPendingPromptSourceProposal(entries: ReadonlyArray<SessionCustomEntryLike>): void {
	const pending = getPendingPromptSourceProposal(entries);
	if (pending) {
		throw new Error(
			`Cannot create a new pending prompt proposal while version ${pending.proposedVersion} is still pending`,
		);
	}
}

export interface BuildPromptSourceStateOptions {
	cwd: string;
	canonicalContent: string;
	canonicalVersion: number;
	effectivePromptPreview?: string;
	sessionEntries?: ReadonlyArray<SessionCustomEntryLike>;
}

export function buildPromptSourceState(options: BuildPromptSourceStateOptions): PromptSourceState {
	const proposals = listPromptSourceProposals(options.sessionEntries ?? []);
	const pendingProposal = getPendingPromptSourceProposal(options.sessionEntries ?? []);

	return {
		canonical: {
			path: getProjectSystemPromptPath(options.cwd),
			content: options.canonicalContent,
			version: options.canonicalVersion,
		},
		effectivePromptPreview: options.effectivePromptPreview,
		proposals,
		pendingProposal,
	};
}
