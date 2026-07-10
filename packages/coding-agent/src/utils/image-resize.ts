import { createRequire } from "node:module";
import type { ImageContent } from "@earendil-works/pi-ai/compat";

const require = createRequire(import.meta.url);
const { resizeImage: napiResize } = require("bindery-tools") as {
	resizeImage: (opts: {
		data: string;
		mimeType: string;
		maxWidth: number;
		maxHeight: number;
		maxBytes: number;
		jpegQuality: number;
	}) => {
		data: string;
		mimeType: string;
		originalWidth: number;
		originalHeight: number;
		width: number;
		height: number;
		wasResized: boolean;
	};
};

export interface ImageResizeOptions {
	maxWidth?: number; // Default: 2000
	maxHeight?: number; // Default: 2000
	maxBytes?: number; // Default: 4.5MB (below Anthropic's 5MB limit)
	jpegQuality?: number; // Default: 80
}

export interface ResizedImage {
	data: string; // base64
	mimeType: string;
	originalWidth: number;
	originalHeight: number;
	width: number;
	height: number;
	wasResized: boolean;
}

// 4.5MB - provides headroom below Anthropic's 5MB limit
const DEFAULT_MAX_BYTES = 4.5 * 1024 * 1024;

const DEFAULT_OPTIONS: Required<ImageResizeOptions> = {
	maxWidth: 2000,
	maxHeight: 2000,
	maxBytes: DEFAULT_MAX_BYTES,
	jpegQuality: 80,
};

/**
 * Resize an image to fit within the specified max dimensions and file size.
 * Returns the original image if it already fits within the limits.
 *
 * Uses the bindery-tools native Rust module for image processing.
 *
 * Strategy for staying under maxBytes:
 * 1. First resize to maxWidth/maxHeight
 * 2. Try both PNG and JPEG formats, pick the smaller one
 * 3. If still too large, try JPEG with decreasing quality
 * 4. If still too large, progressively reduce dimensions
 */
export async function resizeImage(img: ImageContent, options?: ImageResizeOptions): Promise<ResizedImage> {
	const opts = { ...DEFAULT_OPTIONS, ...options };

	try {
		const result = napiResize({
			data: img.data,
			mimeType: img.mimeType,
			maxWidth: opts.maxWidth,
			maxHeight: opts.maxHeight,
			maxBytes: opts.maxBytes,
			jpegQuality: opts.jpegQuality,
		});

		return {
			data: result.data,
			mimeType: result.mimeType,
			originalWidth: result.originalWidth,
			originalHeight: result.originalHeight,
			width: result.width,
			height: result.height,
			wasResized: result.wasResized,
		};
	} catch {
		// Native module failed, return original image
		return {
			data: img.data,
			mimeType: img.mimeType,
			originalWidth: 0,
			originalHeight: 0,
			width: 0,
			height: 0,
			wasResized: false,
		};
	}
}

/**
 * Format a dimension note for resized images.
 * This helps the model understand the coordinate mapping.
 */
export function formatDimensionNote(result: ResizedImage): string | undefined {
	if (!result.wasResized) {
		return undefined;
	}

	const scale = result.originalWidth / result.width;
	return `[Image: original ${result.originalWidth}x${result.originalHeight}, displayed at ${result.width}x${result.height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`;
}
