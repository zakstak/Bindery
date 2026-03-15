import type { Theme } from "./theme/theme.js";

const passthrough = (text: string): string => text;

export const headlessTheme = {
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
} as unknown as Theme;
