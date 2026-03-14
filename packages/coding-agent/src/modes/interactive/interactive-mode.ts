import type { ImageContent } from "@mariozechner/pi-ai";
import { APP_NAME } from "../../config.js";
import type { AgentSession } from "../../core/agent-session.js";

const INTERACTIVE_MODE_REMOVED_ERROR =
	`${APP_NAME} no longer ships an interactive terminal UI. ` +
	"Open Bindery for interactive chat, session browsing, and other UI-driven flows.";

export interface InteractiveModeOptions {
	migratedProviders?: string[];
	modelFallbackMessage?: string;
	initialMessage?: string;
	initialImages?: ImageContent[];
	initialMessages?: string[];
	verbose?: boolean;
}

export class InteractiveMode {
	constructor(
		private readonly _session: AgentSession,
		private readonly _options: InteractiveModeOptions = {},
	) {}

	async init(): Promise<void> {
		void this._session;
		void this._options;
	}

	async run(): Promise<never> {
		throw new Error(INTERACTIVE_MODE_REMOVED_ERROR);
	}

	stop(): void {}
}
