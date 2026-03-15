type Letter =
	| "a"
	| "b"
	| "c"
	| "d"
	| "e"
	| "f"
	| "g"
	| "h"
	| "i"
	| "j"
	| "k"
	| "l"
	| "m"
	| "n"
	| "o"
	| "p"
	| "q"
	| "r"
	| "s"
	| "t"
	| "u"
	| "v"
	| "w"
	| "x"
	| "y"
	| "z";
type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";
type SymbolKey =
	| "`"
	| "-"
	| "="
	| "["
	| "]"
	| "\\"
	| ";"
	| "'"
	| ","
	| "."
	| "/"
	| "!"
	| "@"
	| "#"
	| "$"
	| "%"
	| "^"
	| "&"
	| "*"
	| "("
	| ")"
	| "_"
	| "+"
	| "|"
	| "~"
	| "{"
	| "}"
	| ":"
	| "<"
	| ">"
	| "?";
type SpecialKey =
	| "escape"
	| "esc"
	| "enter"
	| "return"
	| "tab"
	| "space"
	| "backspace"
	| "delete"
	| "insert"
	| "clear"
	| "home"
	| "end"
	| "pageUp"
	| "pageDown"
	| "up"
	| "down"
	| "left"
	| "right"
	| "f1"
	| "f2"
	| "f3"
	| "f4"
	| "f5"
	| "f6"
	| "f7"
	| "f8"
	| "f9"
	| "f10"
	| "f11"
	| "f12";
type BaseKey = Letter | Digit | SymbolKey | SpecialKey;

export type KeyId =
	| BaseKey
	| `ctrl+${BaseKey}`
	| `shift+${BaseKey}`
	| `alt+${BaseKey}`
	| `ctrl+shift+${BaseKey}`
	| `shift+ctrl+${BaseKey}`
	| `ctrl+alt+${BaseKey}`
	| `alt+ctrl+${BaseKey}`
	| `shift+alt+${BaseKey}`
	| `alt+shift+${BaseKey}`
	| `ctrl+shift+alt+${BaseKey}`
	| `ctrl+alt+shift+${BaseKey}`
	| `shift+ctrl+alt+${BaseKey}`
	| `shift+alt+ctrl+${BaseKey}`
	| `alt+ctrl+shift+${BaseKey}`
	| `alt+shift+ctrl+${BaseKey}`;

type ParsedKittyKey = {
	codepoint: number;
	modifier: number;
};

const MODIFIERS = {
	shift: 1,
	alt: 2,
	ctrl: 4,
} as const;

const LOCK_MASK = 64 + 128;

const CODEPOINTS = {
	escape: 27,
	tab: 9,
	enter: 13,
	space: 32,
	backspace: 127,
	kpEnter: 57414,
} as const;

const ARROW_CODEPOINTS = {
	up: -1,
	down: -2,
	right: -3,
	left: -4,
} as const;

const FUNCTIONAL_CODEPOINTS = {
	delete: -10,
	insert: -11,
	pageUp: -12,
	pageDown: -13,
	home: -14,
	end: -15,
} as const;

const LEGACY_KEY_SEQUENCES = {
	up: ["\x1b[A", "\x1bOA"],
	down: ["\x1b[B", "\x1bOB"],
	right: ["\x1b[C", "\x1bOC"],
	left: ["\x1b[D", "\x1bOD"],
	home: ["\x1b[H", "\x1bOH", "\x1b[1~", "\x1b[7~"],
	end: ["\x1b[F", "\x1bOF", "\x1b[4~", "\x1b[8~"],
	insert: ["\x1b[2~"],
	delete: ["\x1b[3~"],
	pageUp: ["\x1b[5~", "\x1b[[5~"],
	pageDown: ["\x1b[6~", "\x1b[[6~"],
	clear: ["\x1b[E", "\x1bOE"],
	f1: ["\x1bOP", "\x1b[11~", "\x1b[[A"],
	f2: ["\x1bOQ", "\x1b[12~", "\x1b[[B"],
	f3: ["\x1bOR", "\x1b[13~", "\x1b[[C"],
	f4: ["\x1bOS", "\x1b[14~", "\x1b[[D"],
	f5: ["\x1b[15~", "\x1b[[E"],
	f6: ["\x1b[17~"],
	f7: ["\x1b[18~"],
	f8: ["\x1b[19~"],
	f9: ["\x1b[20~"],
	f10: ["\x1b[21~"],
	f11: ["\x1b[23~"],
	f12: ["\x1b[24~"],
} as const;

const LEGACY_SHIFT_SEQUENCES = {
	up: ["\x1b[a"],
	down: ["\x1b[b"],
	right: ["\x1b[c"],
	left: ["\x1b[d"],
	clear: ["\x1b[e"],
	insert: ["\x1b[2$"],
	delete: ["\x1b[3$"],
	pageUp: ["\x1b[5$"],
	pageDown: ["\x1b[6$"],
	home: ["\x1b[7$"],
	end: ["\x1b[8$"],
} as const;

const LEGACY_CTRL_SEQUENCES = {
	up: ["\x1bOa"],
	down: ["\x1bOb"],
	right: ["\x1bOc"],
	left: ["\x1bOd"],
	clear: ["\x1bOe"],
	insert: ["\x1b[2^"],
	delete: ["\x1b[3^"],
	pageUp: ["\x1b[5^"],
	pageDown: ["\x1b[6^"],
	home: ["\x1b[7^"],
	end: ["\x1b[8^"],
} as const;

function parseKeyId(keyId: KeyId): { key: string; ctrl: boolean; shift: boolean; alt: boolean } | null {
	const parts = keyId.toLowerCase().split("+");
	const key = parts[parts.length - 1];
	if (!key) return null;

	return {
		key,
		ctrl: parts.includes("ctrl"),
		shift: parts.includes("shift"),
		alt: parts.includes("alt"),
	};
}

function matchesLegacySequence(data: string, sequences: readonly string[]): boolean {
	return sequences.includes(data);
}

function matchesLegacyModifierSequence(
	data: string,
	key: keyof typeof LEGACY_SHIFT_SEQUENCES,
	modifier: number,
): boolean {
	if (modifier === MODIFIERS.shift) {
		return matchesLegacySequence(data, LEGACY_SHIFT_SEQUENCES[key]);
	}
	if (modifier === MODIFIERS.ctrl) {
		return matchesLegacySequence(data, LEGACY_CTRL_SEQUENCES[key]);
	}
	return false;
}

function parseKittySequence(data: string): ParsedKittyKey | null {
	const csiUMatch = data.match(/^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u$/);
	if (csiUMatch) {
		const codepoint = Number.parseInt(csiUMatch[1] ?? "", 10);
		const modValue = csiUMatch[4] ? Number.parseInt(csiUMatch[4], 10) : 1;
		return { codepoint, modifier: modValue - 1 };
	}

	const arrowMatch = data.match(/^\x1b\[1;(\d+)(?::(\d+))?([ABCD])$/);
	if (arrowMatch) {
		const modValue = Number.parseInt(arrowMatch[1] ?? "", 10);
		const arrowCodes = { A: -1, B: -2, C: -3, D: -4 } as const;
		return { codepoint: arrowCodes[arrowMatch[3] as keyof typeof arrowCodes], modifier: modValue - 1 };
	}

	const funcMatch = data.match(/^\x1b\[(\d+)(?:;(\d+))?(?::(\d+))?~$/);
	if (funcMatch) {
		const keyNum = Number.parseInt(funcMatch[1] ?? "", 10);
		const modValue = funcMatch[2] ? Number.parseInt(funcMatch[2], 10) : 1;
		const funcCodes: Record<number, number> = {
			2: FUNCTIONAL_CODEPOINTS.insert,
			3: FUNCTIONAL_CODEPOINTS.delete,
			5: FUNCTIONAL_CODEPOINTS.pageUp,
			6: FUNCTIONAL_CODEPOINTS.pageDown,
			7: FUNCTIONAL_CODEPOINTS.home,
			8: FUNCTIONAL_CODEPOINTS.end,
		};
		const codepoint = funcCodes[keyNum];
		if (codepoint !== undefined) {
			return { codepoint, modifier: modValue - 1 };
		}
	}

	const homeEndMatch = data.match(/^\x1b\[1;(\d+)(?::(\d+))?([HF])$/);
	if (homeEndMatch) {
		const modValue = Number.parseInt(homeEndMatch[1] ?? "", 10);
		const codepoint = homeEndMatch[3] === "H" ? FUNCTIONAL_CODEPOINTS.home : FUNCTIONAL_CODEPOINTS.end;
		return { codepoint, modifier: modValue - 1 };
	}

	return null;
}

function matchesKittySequence(data: string, expectedCodepoint: number, expectedModifier: number): boolean {
	const parsed = parseKittySequence(data);
	if (!parsed) return false;

	const actualMod = parsed.modifier & ~LOCK_MASK;
	const expectedMod = expectedModifier & ~LOCK_MASK;
	return parsed.codepoint === expectedCodepoint && actualMod === expectedMod;
}

function parseModifyOtherKeysSequence(data: string): ParsedKittyKey | null {
	const match = data.match(/^\x1b\[27;(\d+);(\d+)~$/);
	if (!match) return null;

	const modValue = Number.parseInt(match[1] ?? "", 10);
	const codepoint = Number.parseInt(match[2] ?? "", 10);
	return { codepoint, modifier: modValue - 1 };
}

function matchesModifyOtherKeys(data: string, expectedCodepoint: number, expectedModifier: number): boolean {
	const parsed = parseModifyOtherKeysSequence(data);
	if (!parsed) return false;

	return parsed.codepoint === expectedCodepoint && parsed.modifier === expectedModifier;
}

function rawCtrlChar(key: string): string | null {
	const char = key.toLowerCase();
	const code = char.charCodeAt(0);
	if ((code >= 97 && code <= 122) || char === "[" || char === "\\" || char === "]" || char === "_") {
		return String.fromCharCode(code & 0x1f);
	}
	if (char === "-") {
		return String.fromCharCode(31);
	}
	return null;
}

function isDigitKey(key: string): boolean {
	return key >= "0" && key <= "9";
}

function isSymbolKey(key: string): boolean {
	return /^[-=`[\]\\;',./!@#$%^&*()_+|~{}:<>?]$/.test(key);
}

export function matchesKey(data: string, keyId: KeyId): boolean {
	const parsed = parseKeyId(keyId);
	if (!parsed) return false;

	let { key } = parsed;
	const { ctrl, shift, alt } = parsed;
	if (key === "esc") key = "escape";
	if (key === "return") key = "enter";
	if (key === "pageup") key = "pageUp";
	if (key === "pagedown") key = "pageDown";

	let modifier = 0;
	if (shift) modifier |= MODIFIERS.shift;
	if (alt) modifier |= MODIFIERS.alt;
	if (ctrl) modifier |= MODIFIERS.ctrl;

	if (key === "escape") {
		if (modifier !== 0) return false;
		return data === "\x1b" || matchesKittySequence(data, CODEPOINTS.escape, 0);
	}

	if (key === "space") {
		if (ctrl && !alt && !shift && data === "\x00") return true;
		if (alt && !ctrl && !shift && data === "\x1b ") return true;
		if (modifier === 0) return data === " " || matchesKittySequence(data, CODEPOINTS.space, 0);
		return matchesKittySequence(data, CODEPOINTS.space, modifier);
	}

	if (key === "tab") {
		if (shift && !ctrl && !alt) {
			return data === "\x1b[Z" || matchesKittySequence(data, CODEPOINTS.tab, MODIFIERS.shift);
		}
		if (modifier === 0) return data === "\t" || matchesKittySequence(data, CODEPOINTS.tab, 0);
		return matchesKittySequence(data, CODEPOINTS.tab, modifier);
	}

	if (key === "enter") {
		if (shift && !ctrl && !alt) {
			if (
				matchesKittySequence(data, CODEPOINTS.enter, MODIFIERS.shift) ||
				matchesKittySequence(data, CODEPOINTS.kpEnter, MODIFIERS.shift)
			) {
				return true;
			}
			if (matchesModifyOtherKeys(data, CODEPOINTS.enter, MODIFIERS.shift)) return true;
			return data === "\x1b\r" || data === "\n";
		}
		if (alt && !ctrl && !shift) {
			if (
				matchesKittySequence(data, CODEPOINTS.enter, MODIFIERS.alt) ||
				matchesKittySequence(data, CODEPOINTS.kpEnter, MODIFIERS.alt)
			) {
				return true;
			}
			if (matchesModifyOtherKeys(data, CODEPOINTS.enter, MODIFIERS.alt)) return true;
			return data === "\x1b\r";
		}
		if (modifier === 0) {
			return (
				data === "\r" ||
				data === "\n" ||
				data === "\x1bOM" ||
				matchesKittySequence(data, CODEPOINTS.enter, 0) ||
				matchesKittySequence(data, CODEPOINTS.kpEnter, 0)
			);
		}
		return (
			matchesKittySequence(data, CODEPOINTS.enter, modifier) ||
			matchesKittySequence(data, CODEPOINTS.kpEnter, modifier) ||
			matchesModifyOtherKeys(data, CODEPOINTS.enter, modifier)
		);
	}

	if (key === "backspace") {
		if (alt && !ctrl && !shift) {
			if (data === "\x1b\x7f" || data === "\x1b\b") return true;
			return matchesKittySequence(data, CODEPOINTS.backspace, MODIFIERS.alt);
		}
		if (modifier === 0) {
			return data === "\x7f" || data === "\x08" || matchesKittySequence(data, CODEPOINTS.backspace, 0);
		}
		return matchesKittySequence(data, CODEPOINTS.backspace, modifier);
	}

	if (key in FUNCTIONAL_CODEPOINTS) {
		const normalized = key as keyof typeof FUNCTIONAL_CODEPOINTS;
		if (modifier === 0) {
			return (
				matchesLegacySequence(data, LEGACY_KEY_SEQUENCES[normalized]) ||
				matchesKittySequence(data, FUNCTIONAL_CODEPOINTS[normalized], 0)
			);
		}
		if (matchesLegacyModifierSequence(data, normalized, modifier)) {
			return true;
		}
		return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS[normalized], modifier);
	}

	if (key in ARROW_CODEPOINTS) {
		const normalized = key as keyof typeof ARROW_CODEPOINTS;
		if (alt && !ctrl && !shift) {
			if (normalized === "left" && (data === "\x1bb" || data === "\x1bB")) return true;
			if (normalized === "right" && (data === "\x1bf" || data === "\x1bF")) return true;
			if (normalized === "up" && data === "\x1bp") return true;
			if (normalized === "down" && data === "\x1bn") return true;
			return matchesKittySequence(data, ARROW_CODEPOINTS[normalized], MODIFIERS.alt);
		}
		if (modifier === 0) {
			return (
				matchesLegacySequence(data, LEGACY_KEY_SEQUENCES[normalized]) ||
				matchesKittySequence(data, ARROW_CODEPOINTS[normalized], 0)
			);
		}
		if (matchesLegacyModifierSequence(data, normalized, modifier)) {
			return true;
		}
		return matchesKittySequence(data, ARROW_CODEPOINTS[normalized], modifier);
	}

	if (/^f([1-9]|1[0-2])$/.test(key)) {
		if (modifier !== 0) return false;
		const functionKey = key as keyof typeof LEGACY_KEY_SEQUENCES;
		return matchesLegacySequence(data, LEGACY_KEY_SEQUENCES[functionKey]);
	}

	if (key.length === 1 && ((key >= "a" && key <= "z") || isDigitKey(key) || isSymbolKey(key))) {
		const codepoint = key.charCodeAt(0);
		const rawCtrl = rawCtrlChar(key);
		const isLetter = key >= "a" && key <= "z";
		const isDigit = isDigitKey(key);

		if (ctrl && alt && !shift && rawCtrl && data === `\x1b${rawCtrl}`) {
			return true;
		}
		if (alt && !ctrl && !shift && (isLetter || isDigit) && data === `\x1b${key}`) {
			return true;
		}
		if (ctrl && !shift && !alt) {
			if (rawCtrl && data === rawCtrl) return true;
			return (
				matchesKittySequence(data, codepoint, MODIFIERS.ctrl) ||
				matchesModifyOtherKeys(data, codepoint, MODIFIERS.ctrl)
			);
		}
		if (ctrl && shift && !alt) {
			return (
				matchesKittySequence(data, codepoint, MODIFIERS.shift + MODIFIERS.ctrl) ||
				matchesModifyOtherKeys(data, codepoint, MODIFIERS.shift + MODIFIERS.ctrl)
			);
		}
		if (shift && !ctrl && !alt) {
			if (isLetter && data === key.toUpperCase()) return true;
			return (
				matchesKittySequence(data, codepoint, MODIFIERS.shift) ||
				matchesModifyOtherKeys(data, codepoint, MODIFIERS.shift)
			);
		}
		if (modifier !== 0) {
			return matchesKittySequence(data, codepoint, modifier) || matchesModifyOtherKeys(data, codepoint, modifier);
		}
		return data === key || matchesKittySequence(data, codepoint, 0);
	}

	return false;
}
