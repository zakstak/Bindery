import { createRequire } from "node:module";
import { readFileSync, statSync } from "fs";
import path from "path";

const require = createRequire(import.meta.url);
const { rgSearch } = require("bindery-tools") as {
	rgSearch: (opts: {
		pattern: string;
		path: string;
		glob?: string;
		ignoreCase?: boolean;
		literal?: boolean;
		limit?: number;
	}) => Array<{ filePath: string; lineNumber: number; lineText: string }>;
};

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { resolveToCwd } from "./path-utils.js";
import {
	DEFAULT_MAX_BYTES,
	formatSize,
	GREP_MAX_LINE_LENGTH,
	type TruncationResult,
	truncateHead,
	truncateLine,
} from "./truncate.js";

const grepSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
	glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
	literal: Type.Optional(
		Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" }),
	),
	context: Type.Optional(
		Type.Number({ description: "Number of lines to show before and after each match (default: 0)" }),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
});

export type GrepToolInput = Static<typeof grepSchema>;

const DEFAULT_LIMIT = 100;

export interface GrepToolDetails {
	truncation?: TruncationResult;
	matchLimitReached?: number;
	linesTruncated?: boolean;
}

/**
 * Pluggable operations for the grep tool.
 * Override these to delegate search to remote systems (e.g., SSH).
 */
export interface GrepOperations {
	/** Check if path is a directory. Throws if path doesn't exist. */
	isDirectory: (absolutePath: string) => Promise<boolean> | boolean;
	/** Read file contents for context lines */
	readFile: (absolutePath: string) => Promise<string> | string;
}

const defaultGrepOperations: GrepOperations = {
	isDirectory: (p) => statSync(p).isDirectory(),
	readFile: (p) => readFileSync(p, "utf-8"),
};

export interface GrepToolOptions {
	/** Custom operations for grep. Default: local filesystem + native ripgrep */
	operations?: GrepOperations;
}

export function createGrepTool(cwd: string, options?: GrepToolOptions): AgentTool<typeof grepSchema> {
	const customOps = options?.operations;

	return {
		name: "grep",
		label: "grep",
		description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
		parameters: grepSchema,
		execute: async (
			_toolCallId: string,
			{
				pattern,
				path: searchDir,
				glob,
				ignoreCase,
				literal,
				context,
				limit,
			}: {
				pattern: string;
				path?: string;
				glob?: string;
				ignoreCase?: boolean;
				literal?: boolean;
				context?: number;
				limit?: number;
			},
			signal?: AbortSignal,
		) => {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			const searchPath = resolveToCwd(searchDir || ".", cwd);
			const ops = customOps ?? defaultGrepOperations;

			let isDirectory: boolean;
			try {
				isDirectory = await ops.isDirectory(searchPath);
			} catch (_err) {
				throw new Error(`Path not found: ${searchPath}`);
			}

			const contextValue = context && context > 0 ? context : 0;
			const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);

			// Check abort before search
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			// Perform NAPI ripgrep search
			const matches = rgSearch({
				pattern,
				path: searchPath,
				glob,
				ignoreCase,
				literal,
				limit: effectiveLimit,
			});

			if (matches.length === 0) {
				return { content: [{ type: "text", text: "No matches found" }], details: undefined };
			}

			const matchLimitReached = matches.length >= effectiveLimit;

			const formatPath = (filePath: string): string => {
				if (isDirectory) {
					const relative = path.relative(searchPath, filePath);
					if (relative && !relative.startsWith("..")) {
						return relative.replace(/\\/g, "/");
					}
				}
				return path.basename(filePath);
			};

			const fileCache = new Map<string, string[]>();
			const getFileLines = async (filePath: string): Promise<string[]> => {
				let lines = fileCache.get(filePath);
				if (!lines) {
					try {
						const content = await ops.readFile(filePath);
						lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
					} catch {
						lines = [];
					}
					fileCache.set(filePath, lines);
				}
				return lines;
			};

			let linesTruncated = false;
			const outputLines: string[] = [];

			for (const match of matches) {
				const relativePath = formatPath(match.filePath);
				const lineNumber = match.lineNumber;

				if (contextValue > 0) {
					// Need to read file for context lines
					const lines = await getFileLines(match.filePath);
					if (!lines.length) {
						outputLines.push(`${relativePath}:${lineNumber}: (unable to read file)`);
						continue;
					}

					const start = Math.max(1, lineNumber - contextValue);
					const end = Math.min(lines.length, lineNumber + contextValue);

					for (let current = start; current <= end; current++) {
						const lineText = lines[current - 1] ?? "";
						const sanitized = lineText.replace(/\r/g, "");
						const isMatchLine = current === lineNumber;

						const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
						if (wasTruncated) {
							linesTruncated = true;
						}

						if (isMatchLine) {
							outputLines.push(`${relativePath}:${current}: ${truncatedText}`);
						} else {
							outputLines.push(`${relativePath}-${current}- ${truncatedText}`);
						}
					}
				} else {
					// No context - use the line text from the match directly
					const { text: truncatedText, wasTruncated } = truncateLine(match.lineText);
					if (wasTruncated) {
						linesTruncated = true;
					}
					outputLines.push(`${relativePath}:${lineNumber}: ${truncatedText}`);
				}
			}

			// Apply byte truncation
			const rawOutput = outputLines.join("\n");
			const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });

			let output = truncation.content;
			const details: GrepToolDetails = {};

			// Build notices
			const notices: string[] = [];

			if (matchLimitReached) {
				notices.push(
					`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
				);
				details.matchLimitReached = effectiveLimit;
			}

			if (truncation.truncated) {
				notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
				details.truncation = truncation;
			}

			if (linesTruncated) {
				notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
				details.linesTruncated = true;
			}

			if (notices.length > 0) {
				output += `\n\n[${notices.join(". ")}]`;
			}

			return {
				content: [{ type: "text", text: output }],
				details: Object.keys(details).length > 0 ? details : undefined,
			};
		},
	};
}

/** Default grep tool using process.cwd() - for backwards compatibility */
export const grepTool = createGrepTool(process.cwd());
