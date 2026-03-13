import type { SessionEntry } from "./session-manager.js";

export const HANDOFF_DOCUMENT_CUSTOM_TYPE = "handoff_document";
export const HANDOFF_CONTEXT_CUSTOM_TYPE = "handoff_context";
export const HANDOFF_SCHEMA_VERSION = 1;

interface FileTrackingDetails {
	readFiles?: string[];
	modifiedFiles?: string[];
}

function hasFileTrackingDetails(value: unknown): value is FileTrackingDetails {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	return Array.isArray(candidate.readFiles) || Array.isArray(candidate.modifiedFiles);
}

export interface HandoffContextUsage {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

export interface HandoffDocument {
	schemaVersion: number;
	createdAt: string;
	sessionId: string;
	sessionFile?: string;
	sessionName?: string;
	cwd: string;
	model?: string;
	thinkingLevel?: string;
	goal: string;
	currentState: string[];
	relevantFiles: string[];
	openRisks: string[];
	nextStep: string;
	notes?: string;
}

export interface CreateHandoffDocumentOptions {
	sessionId: string;
	sessionFile?: string;
	sessionName?: string;
	cwd: string;
	model?: string;
	thinkingLevel?: string;
	contextUsage?: HandoffContextUsage;
	latestUserGoal?: string;
	latestAssistantText?: string;
	relevantFiles?: string[];
	pendingMessageCount?: number;
	pendingPromptProposalVersion?: number;
	notes?: string;
	timestamp?: string;
}

export function collectHandoffRelevantFiles(entries: ReadonlyArray<SessionEntry>): string[] {
	const files = new Set<string>();
	for (const entry of entries) {
		if ((entry.type !== "compaction" && entry.type !== "branch_summary") || !hasFileTrackingDetails(entry.details)) {
			continue;
		}
		for (const file of entry.details.readFiles ?? []) {
			if (typeof file === "string" && file.trim()) files.add(file);
		}
		for (const file of entry.details.modifiedFiles ?? []) {
			if (typeof file === "string" && file.trim()) files.add(file);
		}
	}
	return Array.from(files).sort((a, b) => a.localeCompare(b));
}

function summarizeContextUsage(contextUsage: HandoffContextUsage | undefined): string | undefined {
	if (!contextUsage) {
		return undefined;
	}
	if (contextUsage.percent !== null) {
		return `${Math.round(contextUsage.percent)}% of ${contextUsage.contextWindow.toLocaleString()} tokens`;
	}
	if (contextUsage.tokens !== null) {
		return `${contextUsage.tokens.toLocaleString()} tokens in a ${contextUsage.contextWindow.toLocaleString()} token window`;
	}
	return `context window ${contextUsage.contextWindow.toLocaleString()} tokens`;
}

export function createHandoffDocument(options: CreateHandoffDocumentOptions): HandoffDocument {
	const currentState: string[] = [];
	currentState.push(`Session: ${options.sessionName ?? options.sessionId}`);
	currentState.push(`Model: ${options.model ?? "not set"}`);
	if (options.thinkingLevel) {
		currentState.push(`Thinking level: ${options.thinkingLevel}`);
	}
	const contextSummary = summarizeContextUsage(options.contextUsage);
	if (contextSummary) {
		currentState.push(`Context: ${contextSummary}`);
	}
	if (options.latestAssistantText?.trim()) {
		currentState.push(`Latest assistant update: ${options.latestAssistantText.trim()}`);
	}

	const openRisks: string[] = [];
	if ((options.pendingMessageCount ?? 0) > 0) {
		openRisks.push(`${options.pendingMessageCount} queued message(s) are still pending.`);
	}
	if (options.pendingPromptProposalVersion !== undefined) {
		openRisks.push(`Prompt proposal v${options.pendingPromptProposalVersion} is still pending review.`);
	}
	if (!options.model) {
		openRisks.push("No model is selected in the current session.");
	}
	const contextPercent = options.contextUsage?.percent;
	if (contextPercent !== undefined && contextPercent !== null && contextPercent >= 85) {
		openRisks.push(`Context usage is high at ${Math.round(contextPercent)}%.`);
	}

	return {
		schemaVersion: HANDOFF_SCHEMA_VERSION,
		createdAt: options.timestamp ?? new Date().toISOString(),
		sessionId: options.sessionId,
		sessionFile: options.sessionFile,
		sessionName: options.sessionName,
		cwd: options.cwd,
		model: options.model,
		thinkingLevel: options.thinkingLevel,
		goal: options.latestUserGoal?.trim() || "Continue the current work from the latest verified state.",
		currentState,
		relevantFiles: [...(options.relevantFiles ?? [])],
		openRisks,
		nextStep: options.notes?.trim() || "Resume from this handoff, verify assumptions, and continue the work.",
		notes: options.notes?.trim() || undefined,
	};
}

function renderBulletList(items: readonly string[], emptyText: string): string {
	if (items.length === 0) {
		return `- ${emptyText}`;
	}
	return items.map((item) => `- ${item}`).join("\n");
}

export function buildHandoffMarkdown(document: HandoffDocument): string {
	return [
		"## Goal",
		document.goal,
		"",
		"## Current State",
		renderBulletList(document.currentState, "State not captured."),
		"",
		"## Relevant Files",
		renderBulletList(document.relevantFiles, "No relevant files were captured."),
		"",
		"## Open Risks",
		renderBulletList(document.openRisks, "No explicit risks were captured."),
		"",
		"## Next Step",
		document.nextStep,
		"",
		"## Metadata",
		`- Session ID: ${document.sessionId}`,
		`- Session file: ${document.sessionFile ?? "in-memory"}`,
		`- CWD: ${document.cwd}`,
		`- Created at: ${document.createdAt}`,
	].join("\n");
}
