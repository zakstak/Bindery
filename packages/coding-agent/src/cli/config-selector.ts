import type { ResolvedPaths } from "../core/package-manager.js";
import type { SettingsManager } from "../core/settings-manager.js";

export interface ConfigSelectorOptions {
	resolvedPaths: ResolvedPaths;
	settingsManager: SettingsManager;
	cwd: string;
	agentDir: string;
}

const CONFIG_SELECTOR_RETIRED_ERROR =
	"The terminal config selector has been retired. Open Bindery web for interactive configuration, or edit settings.json directly.";

export async function selectConfig(options: ConfigSelectorOptions): Promise<void> {
	void options;
	throw new Error(CONFIG_SELECTOR_RETIRED_ERROR);
}
