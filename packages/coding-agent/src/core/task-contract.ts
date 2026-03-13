import { randomUUID } from "node:crypto";

export const TASK_PACKET_CUSTOM_TYPE = "task_packet";
export const TASK_CONTEXT_CUSTOM_TYPE = "task_context";
export const TASK_RESULT_CUSTOM_TYPE = "task_result";
export const TASK_RESULT_CONTEXT_CUSTOM_TYPE = "task_result_context";
export const TASK_SCHEMA_VERSION = 1;

export interface TaskPacket {
	schemaVersion: number;
	taskId: string;
	createdAt: string;
	parentSessionId: string;
	parentSessionFile?: string;
	cwd: string;
	model?: string;
	goal: string;
	constraints: string[];
	relevantFiles: string[];
	doneDefinition: string;
	notes?: string;
}

export interface TaskResultSummary {
	schemaVersion: number;
	taskId: string;
	createdAt: string;
	childSessionId: string;
	childSessionFile?: string;
	parentSessionFile?: string;
	model?: string;
	summary: string;
	changedFiles: string[];
	openRisks: string[];
	nextStep: string;
	notes?: string;
}

export interface CreateTaskPacketOptions {
	parentSessionId: string;
	parentSessionFile?: string;
	cwd: string;
	model?: string;
	goal: string;
	constraints?: string[];
	relevantFiles?: string[];
	doneDefinition?: string;
	notes?: string;
	timestamp?: string;
}

export interface CreateTaskResultSummaryOptions {
	taskId: string;
	childSessionId: string;
	childSessionFile?: string;
	parentSessionFile?: string;
	model?: string;
	summary: string;
	changedFiles?: string[];
	openRisks?: string[];
	nextStep?: string;
	notes?: string;
	timestamp?: string;
}

interface SessionCustomEntryLike {
	type: string;
	customType?: string;
	data?: unknown;
	content?: unknown;
	details?: unknown;
}

function isTaskPacket(value: unknown): value is TaskPacket {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	return (
		candidate.schemaVersion === TASK_SCHEMA_VERSION &&
		typeof candidate.taskId === "string" &&
		typeof candidate.createdAt === "string" &&
		typeof candidate.parentSessionId === "string" &&
		(candidate.parentSessionFile === undefined || typeof candidate.parentSessionFile === "string") &&
		typeof candidate.cwd === "string" &&
		(candidate.model === undefined || typeof candidate.model === "string") &&
		typeof candidate.goal === "string" &&
		Array.isArray(candidate.constraints) &&
		Array.isArray(candidate.relevantFiles) &&
		typeof candidate.doneDefinition === "string" &&
		(candidate.notes === undefined || typeof candidate.notes === "string")
	);
}

function isTaskResultSummary(value: unknown): value is TaskResultSummary {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	return (
		candidate.schemaVersion === TASK_SCHEMA_VERSION &&
		typeof candidate.taskId === "string" &&
		typeof candidate.createdAt === "string" &&
		typeof candidate.childSessionId === "string" &&
		(candidate.childSessionFile === undefined || typeof candidate.childSessionFile === "string") &&
		(candidate.parentSessionFile === undefined || typeof candidate.parentSessionFile === "string") &&
		(candidate.model === undefined || typeof candidate.model === "string") &&
		typeof candidate.summary === "string" &&
		Array.isArray(candidate.changedFiles) &&
		Array.isArray(candidate.openRisks) &&
		typeof candidate.nextStep === "string" &&
		(candidate.notes === undefined || typeof candidate.notes === "string")
	);
}

function readTaskResultSummary(entry: SessionCustomEntryLike): TaskResultSummary | undefined {
	if (entry.type === "custom" && entry.customType === TASK_RESULT_CUSTOM_TYPE && isTaskResultSummary(entry.data)) {
		return entry.data;
	}
	if (
		entry.type === "custom_message" &&
		entry.customType === TASK_RESULT_CONTEXT_CUSTOM_TYPE &&
		isTaskResultSummary(entry.details)
	) {
		return entry.details;
	}
	return undefined;
}

function normalizeList(items: readonly string[] | undefined): string[] {
	if (!items) return [];
	const unique = new Set<string>();
	for (const item of items) {
		const normalized = item.trim();
		if (normalized) unique.add(normalized);
	}
	return Array.from(unique);
}

export function createTaskPacket(options: CreateTaskPacketOptions): TaskPacket {
	return {
		schemaVersion: TASK_SCHEMA_VERSION,
		taskId: randomUUID(),
		createdAt: options.timestamp ?? new Date().toISOString(),
		parentSessionId: options.parentSessionId,
		parentSessionFile: options.parentSessionFile,
		cwd: options.cwd,
		model: options.model,
		goal: options.goal.trim(),
		constraints: normalizeList(options.constraints),
		relevantFiles: normalizeList(options.relevantFiles),
		doneDefinition:
			options.doneDefinition?.trim() ||
			"Return one structured result summary with changed files, open risks, and the next recommended step.",
		notes: options.notes?.trim() || undefined,
	};
}

export function createTaskResultSummary(options: CreateTaskResultSummaryOptions): TaskResultSummary {
	return {
		schemaVersion: TASK_SCHEMA_VERSION,
		taskId: options.taskId,
		createdAt: options.timestamp ?? new Date().toISOString(),
		childSessionId: options.childSessionId,
		childSessionFile: options.childSessionFile,
		parentSessionFile: options.parentSessionFile,
		model: options.model,
		summary: options.summary.trim(),
		changedFiles: normalizeList(options.changedFiles),
		openRisks: normalizeList(options.openRisks),
		nextStep: options.nextStep?.trim() || "Return to the parent session and continue from this result.",
		notes: options.notes?.trim() || undefined,
	};
}

function renderBulletList(items: readonly string[], emptyText: string): string {
	if (items.length === 0) {
		return `- ${emptyText}`;
	}
	return items.map((item) => `- ${item}`).join("\n");
}

export function buildTaskPacketMarkdown(packet: TaskPacket): string {
	return [
		"## Task Goal",
		packet.goal,
		"",
		"## Constraints",
		renderBulletList(packet.constraints, "No explicit constraints were captured."),
		"",
		"## Relevant Files",
		renderBulletList(packet.relevantFiles, "No relevant files were captured."),
		"",
		"## Done Definition",
		packet.doneDefinition,
		"",
		"## Notes",
		packet.notes?.trim() || "No extra notes.",
		"",
		"## Metadata",
		`- Task ID: ${packet.taskId}`,
		`- Parent session ID: ${packet.parentSessionId}`,
		`- Parent session file: ${packet.parentSessionFile ?? "in-memory"}`,
		`- CWD: ${packet.cwd}`,
		`- Created at: ${packet.createdAt}`,
	].join("\n");
}

export function buildTaskResultMarkdown(result: TaskResultSummary): string {
	return [
		"## Task Result",
		result.summary,
		"",
		"## Changed Files",
		renderBulletList(result.changedFiles, "No changed files were captured."),
		"",
		"## Open Risks",
		renderBulletList(result.openRisks, "No explicit risks were captured."),
		"",
		"## Next Step",
		result.nextStep,
		"",
		"## Metadata",
		`- Task ID: ${result.taskId}`,
		`- Child session ID: ${result.childSessionId}`,
		`- Child session file: ${result.childSessionFile ?? "in-memory"}`,
		`- Parent session file: ${result.parentSessionFile ?? "in-memory"}`,
		`- Created at: ${result.createdAt}`,
	].join("\n");
}

export function getLatestTaskPacket(entries: ReadonlyArray<SessionCustomEntryLike>): TaskPacket | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "custom" && entry.customType === TASK_PACKET_CUSTOM_TYPE && isTaskPacket(entry.data)) {
			return entry.data;
		}
		if (
			entry.type === "custom_message" &&
			entry.customType === TASK_CONTEXT_CUSTOM_TYPE &&
			isTaskPacket(entry.details)
		) {
			return entry.details;
		}
	}
	return undefined;
}

export function getLatestTaskResult(entries: ReadonlyArray<SessionCustomEntryLike>): TaskResultSummary | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const result = readTaskResultSummary(entries[i]);
		if (result) {
			return result;
		}
	}
	return undefined;
}

export function getTaskResultByTaskId(
	entries: ReadonlyArray<SessionCustomEntryLike>,
	taskId: string,
): TaskResultSummary | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const result = readTaskResultSummary(entries[i]);
		if (result?.taskId === taskId) {
			return result;
		}
	}
	return undefined;
}
