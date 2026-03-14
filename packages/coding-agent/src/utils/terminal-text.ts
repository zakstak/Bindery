const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const zeroWidthRegex = /^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Mark}|\p{Surrogate})+$/u;
const emojiRegex = /\p{Extended_Pictographic}/u;

function isFullWidthCodePoint(codePoint: number): boolean {
	if (
		codePoint >= 0x1100 &&
		(codePoint <= 0x115f ||
			codePoint === 0x2329 ||
			codePoint === 0x232a ||
			(0x2e80 <= codePoint && codePoint <= 0x3247 && codePoint !== 0x303f) ||
			(0x3250 <= codePoint && codePoint <= 0x4dbf) ||
			(0x4e00 <= codePoint && codePoint <= 0xa4c6) ||
			(0xa960 <= codePoint && codePoint <= 0xa97c) ||
			(0xac00 <= codePoint && codePoint <= 0xd7a3) ||
			(0xf900 <= codePoint && codePoint <= 0xfaff) ||
			(0xfe10 <= codePoint && codePoint <= 0xfe19) ||
			(0xfe30 <= codePoint && codePoint <= 0xfe6b) ||
			(0xff01 <= codePoint && codePoint <= 0xff60) ||
			(0xffe0 <= codePoint && codePoint <= 0xffe6) ||
			(0x1f300 <= codePoint && codePoint <= 0x1f64f) ||
			(0x1f900 <= codePoint && codePoint <= 0x1f9ff) ||
			(0x20000 <= codePoint && codePoint <= 0x3fffd))
	) {
		return true;
	}

	return false;
}

function graphemeWidth(segment: string): number {
	if (zeroWidthRegex.test(segment)) {
		return 0;
	}

	if (emojiRegex.test(segment)) {
		return 2;
	}

	const codePoint = segment.codePointAt(0);
	if (codePoint === undefined) {
		return 0;
	}

	return isFullWidthCodePoint(codePoint) ? 2 : 1;
}

export function extractAnsiCode(str: string, pos: number): { code: string; length: number } | null {
	if (pos >= str.length || str[pos] !== "\x1b") {
		return null;
	}

	const next = str[pos + 1];
	if (next === "[") {
		let j = pos + 2;
		while (j < str.length && !/[mGKHJ]/.test(str[j]!)) {
			j++;
		}
		if (j < str.length) {
			return { code: str.substring(pos, j + 1), length: j + 1 - pos };
		}
		return null;
	}

	if (next === "]" || next === "_") {
		let j = pos + 2;
		while (j < str.length) {
			if (str[j] === "\x07") {
				return { code: str.substring(pos, j + 1), length: j + 1 - pos };
			}
			if (str[j] === "\x1b" && str[j + 1] === "\\") {
				return { code: str.substring(pos, j + 2), length: j + 2 - pos };
			}
			j++;
		}
	}

	return null;
}

export function visibleWidth(str: string): number {
	if (str.length === 0) {
		return 0;
	}

	let clean = str;
	if (clean.includes("\t")) {
		clean = clean.replace(/\t/g, "   ");
	}

	if (clean.includes("\x1b")) {
		let stripped = "";
		let i = 0;
		while (i < clean.length) {
			const ansi = extractAnsiCode(clean, i);
			if (ansi) {
				i += ansi.length;
				continue;
			}
			stripped += clean[i];
			i++;
		}
		clean = stripped;
	}

	let width = 0;
	for (const { segment } of segmenter.segment(clean)) {
		width += graphemeWidth(segment);
	}

	return width;
}

export function truncateToWidth(
	text: string,
	maxWidth: number,
	ellipsis: string = "...",
	pad: boolean = false,
): string {
	const textWidth = visibleWidth(text);
	if (textWidth <= maxWidth) {
		return pad ? text + " ".repeat(maxWidth - textWidth) : text;
	}

	const ellipsisWidth = visibleWidth(ellipsis);
	const targetWidth = maxWidth - ellipsisWidth;
	if (targetWidth <= 0) {
		return ellipsis.substring(0, maxWidth);
	}

	const segments: Array<{ type: "ansi" | "grapheme"; value: string }> = [];
	let i = 0;
	while (i < text.length) {
		const ansi = extractAnsiCode(text, i);
		if (ansi) {
			segments.push({ type: "ansi", value: ansi.code });
			i += ansi.length;
			continue;
		}

		let end = i;
		while (end < text.length) {
			const nextAnsi = extractAnsiCode(text, end);
			if (nextAnsi) {
				break;
			}
			end++;
		}

		const textPortion = text.slice(i, end);
		for (const seg of segmenter.segment(textPortion)) {
			segments.push({ type: "grapheme", value: seg.segment });
		}
		i = end;
	}

	let result = "";
	let currentWidth = 0;
	for (const segment of segments) {
		if (segment.type === "ansi") {
			result += segment.value;
			continue;
		}

		if (segment.value.length === 0) {
			continue;
		}

		const width = graphemeWidth(segment.value);
		if (currentWidth + width > targetWidth) {
			break;
		}

		result += segment.value;
		currentWidth += width;
	}

	const truncated = `${result}\x1b[0m${ellipsis}`;
	if (pad) {
		const truncatedWidth = visibleWidth(truncated);
		return truncated + " ".repeat(Math.max(0, maxWidth - truncatedWidth));
	}

	return truncated;
}
