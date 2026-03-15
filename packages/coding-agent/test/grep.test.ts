import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGrepTool, type GrepToolDetails } from "../src/core/tools/grep.js";

/**
 * Helper: execute the grep tool and return the text result + details.
 */
async function runGrep(
	cwd: string,
	input: {
		pattern: string;
		path?: string;
		glob?: string;
		ignoreCase?: boolean;
		literal?: boolean;
		context?: number;
		limit?: number;
	},
	signal?: AbortSignal,
) {
	const tool = createGrepTool(cwd);
	const result = await tool.execute("test-call", input, signal);
	const text = result.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("");
	return { text, details: result.details as GrepToolDetails | undefined };
}

describe("grep tool", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "grep-test-"));

		// Create test fixture files
		writeFileSync(
			join(tempDir, "hello.ts"),
			[
				"export function greet(name: string): string {",
				// biome-ignore lint/suspicious/noTemplateCurlyInString: fixture content
				"  return `Hello, ${name}!`;",
				"}",
				"",
				"export function farewell(name: string): string {",
				// biome-ignore lint/suspicious/noTemplateCurlyInString: fixture content
				"  return `Goodbye, ${name}!`;",
				"}",
			].join("\n"),
		);

		writeFileSync(
			join(tempDir, "data.json"),
			JSON.stringify(
				{
					greeting: "hello world",
					count: 42,
				},
				null,
				2,
			),
		);

		writeFileSync(
			join(tempDir, "readme.md"),
			[
				"# Project README",
				"",
				"This is a test project for grep testing.",
				"It contains multiple files with searchable content.",
			].join("\n"),
		);

		// Nested directory
		mkdirSync(join(tempDir, "src"), { recursive: true });
		writeFileSync(
			join(tempDir, "src", "utils.ts"),
			[
				"export function add(a: number, b: number): number {",
				"  return a + b;",
				"}",
				"",
				"export function multiply(a: number, b: number): number {",
				"  return a * b;",
				"}",
			].join("\n"),
		);

		// Hidden file
		mkdirSync(join(tempDir, ".config"), { recursive: true });
		writeFileSync(
			join(tempDir, ".config", "settings.json"),
			JSON.stringify(
				{
					theme: "dark",
					hidden_value: "secret",
				},
				null,
				2,
			),
		);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	// ── Basic search ──────────────────────────────────────────────

	it("should find regex matches", async () => {
		const { text } = await runGrep(tempDir, { pattern: "function.*string" });
		expect(text).toContain("hello.ts");
		expect(text).toContain("function greet");
		expect(text).toContain("function farewell");
	});

	it("should find literal string matches", async () => {
		const { text } = await runGrep(tempDir, {
			pattern: "return `Hello",
			literal: true,
		});
		expect(text).toContain("hello.ts");
		expect(text).toContain("return `Hello");
	});

	it("should support case-insensitive search", async () => {
		const { text } = await runGrep(tempDir, {
			pattern: "HELLO",
			ignoreCase: true,
		});
		// Should match "hello" in hello.ts and data.json
		expect(text).toContain("hello.ts");
		expect(text).toContain("data.json");
	});

	it("should return 'No matches found' when nothing matches", async () => {
		const { text } = await runGrep(tempDir, { pattern: "nonexistent_xyz_pattern_42" });
		expect(text).toBe("No matches found");
	});

	// ── Glob filtering ────────────────────────────────────────────

	it("should filter by glob pattern", async () => {
		const { text } = await runGrep(tempDir, {
			pattern: "function",
			glob: "*.ts",
		});
		expect(text).toContain("hello.ts");
		// Should not include .json or .md files
		expect(text).not.toContain("data.json");
		expect(text).not.toContain("readme.md");
	});

	it("should support recursive glob patterns", async () => {
		const { text } = await runGrep(tempDir, {
			pattern: "function",
			glob: "**/*.ts",
		});
		expect(text).toContain("hello.ts");
		expect(text).toContain("src/utils.ts");
	});

	// ── Context lines ─────────────────────────────────────────────

	it("should show context lines when requested", async () => {
		const { text } = await runGrep(tempDir, {
			pattern: "return a \\+ b",
			path: join(tempDir, "src", "utils.ts"),
			context: 1,
		});
		// Should show the line before (function signature) and after (closing brace)
		expect(text).toContain("export function add");
		expect(text).toContain("return a + b");
		expect(text).toContain("}");
	});

	it("should show no context by default", async () => {
		const { text } = await runGrep(tempDir, {
			pattern: "return a \\+ b",
			path: join(tempDir, "src", "utils.ts"),
		});
		// Only the matching line, no surrounding context
		const lines = text.trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("return a + b");
	});

	// ── Match limit ───────────────────────────────────────────────

	it("should respect match limit", async () => {
		// Create a file with many matchable lines
		const manyLines = Array.from({ length: 50 }, (_, i) => `line ${i}: match_target`).join("\n");
		writeFileSync(join(tempDir, "many.txt"), manyLines);

		const { text, details } = await runGrep(tempDir, {
			pattern: "match_target",
			path: join(tempDir, "many.txt"),
			limit: 5,
		});

		// Count actual match lines (format: filename:linenum: content)
		const matchLines = text.split("\n").filter((l: string) => l.includes("match_target"));
		expect(matchLines.length).toBe(5);
		expect(details?.matchLimitReached).toBe(5);
	});

	// ── Path handling ─────────────────────────────────────────────

	it("should throw on nonexistent path", async () => {
		await expect(
			runGrep(tempDir, {
				pattern: "test",
				path: join(tempDir, "nonexistent_dir"),
			}),
		).rejects.toThrow(/not found|no such file/i);
	});

	it("should show relative paths for directory search", async () => {
		const { text } = await runGrep(tempDir, { pattern: "function" });
		// Paths should be relative to the search directory
		expect(text).toContain("hello.ts:");
		expect(text).toContain("src/utils.ts:");
		// Should NOT contain full absolute path
		expect(text).not.toContain(tempDir);
	});

	it("should show basename for single-file search", async () => {
		const { text } = await runGrep(tempDir, {
			pattern: "function",
			path: join(tempDir, "hello.ts"),
		});
		expect(text).toContain("hello.ts:");
		expect(text).not.toContain(tempDir);
	});

	// ── Line truncation ───────────────────────────────────────────

	it("should truncate long lines", async () => {
		const longContent = "x".repeat(1000);
		writeFileSync(join(tempDir, "long.txt"), `prefix ${longContent} suffix`);

		const { text, details } = await runGrep(tempDir, {
			pattern: "prefix",
			path: join(tempDir, "long.txt"),
		});

		expect(text).toContain("[truncated]");
		expect(details?.linesTruncated).toBe(true);
	});

	// ── Byte truncation ───────────────────────────────────────────

	it("should truncate output exceeding byte limit", async () => {
		// Create a file with many long lines that will exceed 50KB total output
		const lines: string[] = [];
		for (let i = 0; i < 500; i++) {
			lines.push(`match_line_${i}: ${"a".repeat(200)}`);
		}
		writeFileSync(join(tempDir, "big.txt"), lines.join("\n"));

		const { text, details } = await runGrep(tempDir, {
			pattern: "match_line",
			path: join(tempDir, "big.txt"),
			limit: 500,
		});

		expect(text).toContain("limit reached");
		expect(details?.truncation?.truncated || details?.matchLimitReached).toBeTruthy();
	});

	// ── Hidden files ──────────────────────────────────────────────

	it("should search hidden files", async () => {
		const { text } = await runGrep(tempDir, { pattern: "hidden_value" });
		expect(text).toContain("settings.json");
		expect(text).toContain("hidden_value");
	});

	// ── .gitignore ────────────────────────────────────────────────

	it("should respect .gitignore", async () => {
		// Initialize a git repo so .gitignore is effective
		const { execSync } = await import("node:child_process");
		execSync("git init", { cwd: tempDir, stdio: "pipe" });
		execSync("git config user.email test@test.com", { cwd: tempDir, stdio: "pipe" });
		execSync("git config user.name Test", { cwd: tempDir, stdio: "pipe" });

		writeFileSync(join(tempDir, ".gitignore"), "ignored/\n");
		mkdirSync(join(tempDir, "ignored"), { recursive: true });
		writeFileSync(join(tempDir, "ignored", "secret.txt"), "findme_ignored");
		writeFileSync(join(tempDir, "visible.txt"), "findme_visible");

		const { text } = await runGrep(tempDir, { pattern: "findme" });
		expect(text).toContain("findme_visible");
		expect(text).not.toContain("findme_ignored");
	});

	// ── Binary files ──────────────────────────────────────────────

	it("should still find matches in files with null bytes (binary-like)", async () => {
		// rg in --json mode reports matches even in binary files
		const binaryContent = Buffer.from([
			0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0x00, 0x00, 0x57, 0x6f, 0x72, 0x6c, 0x64, 0x00, 0x00, 0x00,
		]);
		writeFileSync(join(tempDir, "binary.bin"), binaryContent);

		const { text } = await runGrep(tempDir, {
			pattern: "Hello",
			path: join(tempDir, "binary.bin"),
		});
		// rg --json still reports matches in files with null bytes
		expect(text).toContain("Hello");
	});

	// ── Unicode ───────────────────────────────────────────────────

	it("should match Unicode content", async () => {
		writeFileSync(
			join(tempDir, "unicode.txt"),
			["日本語テスト", "Ünïcödé characters", "emoji: 🎉🚀", "café résumé naïve"].join("\n"),
		);

		const { text } = await runGrep(tempDir, {
			pattern: "café",
			path: join(tempDir, "unicode.txt"),
		});
		expect(text).toContain("café résumé naïve");
	});

	// ── Abort signal ──────────────────────────────────────────────

	it("should reject on abort signal", async () => {
		const controller = new AbortController();
		// Abort immediately
		controller.abort();

		await expect(runGrep(tempDir, { pattern: "test" }, controller.signal)).rejects.toThrow(/aborted/i);
	});

	it("should reject when signal is already aborted", async () => {
		// Pre-aborted signal should reject immediately
		const controller = new AbortController();
		controller.abort();

		await expect(runGrep(tempDir, { pattern: "test" }, controller.signal)).rejects.toThrow(/aborted/i);
	});

	// ── Edge cases ────────────────────────────────────────────────

	it("should handle empty files", async () => {
		writeFileSync(join(tempDir, "empty.txt"), "");

		const { text } = await runGrep(tempDir, {
			pattern: "anything",
			path: join(tempDir, "empty.txt"),
		});
		expect(text).toBe("No matches found");
	});

	it("should handle files with only newlines", async () => {
		writeFileSync(join(tempDir, "newlines.txt"), "\n\n\n\n");

		const { text } = await runGrep(tempDir, {
			pattern: "anything",
			path: join(tempDir, "newlines.txt"),
		});
		expect(text).toBe("No matches found");
	});

	it("should handle patterns with special regex characters when literal", async () => {
		writeFileSync(join(tempDir, "special.txt"), "price is $5.00 (USD)\nno match here\n");

		const { text } = await runGrep(tempDir, {
			pattern: "$5.00 (USD)",
			literal: true,
			path: join(tempDir, "special.txt"),
		});
		expect(text).toContain("$5.00 (USD)");
	});

	it("should handle multiple matches in same file", async () => {
		const { text } = await runGrep(tempDir, {
			pattern: "function",
			path: join(tempDir, "hello.ts"),
		});

		// Should have both function declarations
		const matchLines = text.split("\n").filter((l: string) => l.includes(":") && l.includes("function"));
		expect(matchLines.length).toBe(2);
	});

	it("should include line numbers in output", async () => {
		const { text } = await runGrep(tempDir, {
			pattern: "function farewell",
			path: join(tempDir, "hello.ts"),
		});
		// farewell is on line 5
		expect(text).toMatch(/hello\.ts:5:/);
	});
});
