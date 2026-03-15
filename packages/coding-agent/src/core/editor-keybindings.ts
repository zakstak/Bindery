import { type KeyId, matchesKey } from "./key-input.js";

export type EditorAction =
	| "cursorUp"
	| "cursorDown"
	| "cursorLeft"
	| "cursorRight"
	| "cursorWordLeft"
	| "cursorWordRight"
	| "cursorLineStart"
	| "cursorLineEnd"
	| "jumpForward"
	| "jumpBackward"
	| "pageUp"
	| "pageDown"
	| "deleteCharBackward"
	| "deleteCharForward"
	| "deleteWordBackward"
	| "deleteWordForward"
	| "deleteToLineStart"
	| "deleteToLineEnd"
	| "newLine"
	| "submit"
	| "tab"
	| "selectUp"
	| "selectDown"
	| "selectPageUp"
	| "selectPageDown"
	| "selectConfirm"
	| "selectCancel"
	| "copy"
	| "yank"
	| "yankPop"
	| "undo"
	| "expandTools"
	| "treeFoldOrUp"
	| "treeUnfoldOrDown"
	| "toggleSessionPath"
	| "toggleSessionSort"
	| "renameSession"
	| "deleteSession"
	| "deleteSessionNoninvasive";

export type EditorKeybindingsConfig = {
	[K in EditorAction]?: KeyId | KeyId[];
};

export const DEFAULT_EDITOR_KEYBINDINGS: Required<EditorKeybindingsConfig> = {
	cursorUp: "up",
	cursorDown: "down",
	cursorLeft: ["left", "ctrl+b"],
	cursorRight: ["right", "ctrl+f"],
	cursorWordLeft: ["alt+left", "ctrl+left", "alt+b"],
	cursorWordRight: ["alt+right", "ctrl+right", "alt+f"],
	cursorLineStart: ["home", "ctrl+a"],
	cursorLineEnd: ["end", "ctrl+e"],
	jumpForward: "ctrl+]",
	jumpBackward: "ctrl+alt+]",
	pageUp: "pageUp",
	pageDown: "pageDown",
	deleteCharBackward: "backspace",
	deleteCharForward: ["delete", "ctrl+d"],
	deleteWordBackward: ["ctrl+w", "alt+backspace"],
	deleteWordForward: ["alt+d", "alt+delete"],
	deleteToLineStart: "ctrl+u",
	deleteToLineEnd: "ctrl+k",
	newLine: "shift+enter",
	submit: "enter",
	tab: "tab",
	selectUp: "up",
	selectDown: "down",
	selectPageUp: "pageUp",
	selectPageDown: "pageDown",
	selectConfirm: "enter",
	selectCancel: ["escape", "ctrl+c"],
	copy: "ctrl+c",
	yank: "ctrl+y",
	yankPop: "alt+y",
	undo: "ctrl+-",
	expandTools: "ctrl+o",
	treeFoldOrUp: ["ctrl+left", "alt+left"],
	treeUnfoldOrDown: ["ctrl+right", "alt+right"],
	toggleSessionPath: "ctrl+p",
	toggleSessionSort: "ctrl+s",
	renameSession: "ctrl+r",
	deleteSession: "ctrl+d",
	deleteSessionNoninvasive: "ctrl+backspace",
};

export class EditorKeybindingsManager {
	private actionToKeys: Map<EditorAction, KeyId[]>;

	constructor(config: EditorKeybindingsConfig = {}) {
		this.actionToKeys = new Map();
		this.buildMaps(config);
	}

	private buildMaps(config: EditorKeybindingsConfig): void {
		this.actionToKeys.clear();

		for (const [action, keys] of Object.entries(DEFAULT_EDITOR_KEYBINDINGS)) {
			const keyArray = Array.isArray(keys) ? keys : [keys];
			this.actionToKeys.set(action as EditorAction, [...keyArray]);
		}

		for (const [action, keys] of Object.entries(config)) {
			if (keys === undefined) continue;
			const keyArray = Array.isArray(keys) ? keys : [keys];
			this.actionToKeys.set(action as EditorAction, keyArray);
		}
	}

	matches(data: string, action: EditorAction): boolean {
		const keys = this.actionToKeys.get(action);
		if (!keys) return false;
		for (const key of keys) {
			if (matchesKey(data, key)) return true;
		}
		return false;
	}

	getKeys(action: EditorAction): KeyId[] {
		return this.actionToKeys.get(action) ?? [];
	}

	setConfig(config: EditorKeybindingsConfig): void {
		this.buildMaps(config);
	}
}

let globalEditorKeybindings: EditorKeybindingsManager | null = null;

export function getEditorKeybindings(): EditorKeybindingsManager {
	if (!globalEditorKeybindings) {
		globalEditorKeybindings = new EditorKeybindingsManager();
	}
	return globalEditorKeybindings;
}

export function setEditorKeybindings(manager: EditorKeybindingsManager): void {
	globalEditorKeybindings = manager;
}

export type { KeyId };
