import type { SessionInfo, SessionListProgress } from "../core/session-manager.js";

type SessionsLoader = (onProgress?: SessionListProgress) => Promise<SessionInfo[]>;

const SESSION_PICKER_RETIRED_ERROR =
	"The terminal session picker has been retired. Open Bindery web to browse sessions, or pass --session for headless resume.";

export async function selectSession(
	currentSessionsLoader: SessionsLoader,
	allSessionsLoader: SessionsLoader,
): Promise<string | null> {
	void currentSessionsLoader;
	void allSessionsLoader;
	throw new Error(SESSION_PICKER_RETIRED_ERROR);
}
