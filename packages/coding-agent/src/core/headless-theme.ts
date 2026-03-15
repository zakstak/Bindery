/**
 * Minimal Theme type — passthrough stub replacing the full TUI theme system.
 * All formatting functions are no-ops (return text unchanged).
 */
export interface Theme {
	readonly name?: string;
	readonly sourcePath?: string;
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
	italic(text: string): string;
	underline(text: string): string;
	inverse(text: string): string;
	strikethrough(text: string): string;
	getFgAnsi(color: string): string;
	getBgAnsi(color: string): string;
	getColorMode(): "truecolor";
	getThinkingBorderColor(level?: string): (text: string) => string;
	getBashModeBorderColor(): (text: string) => string;
}

const passthrough = (text: string): string => text;

/** Headless theme — all formatting is a no-op */
export const headlessTheme: Theme = {
	name: "headless",
	sourcePath: undefined,
	fg: (_color: string, text: string): string => text,
	bg: (_color: string, text: string): string => text,
	bold: passthrough,
	italic: passthrough,
	underline: passthrough,
	inverse: passthrough,
	strikethrough: passthrough,
	getFgAnsi: (_color: string): string => "",
	getBgAnsi: (_color: string): string => "",
	getColorMode: (): "truecolor" => "truecolor",
	getThinkingBorderColor: (): ((text: string) => string) => passthrough,
	getBashModeBorderColor: (): ((text: string) => string) => passthrough,
};
