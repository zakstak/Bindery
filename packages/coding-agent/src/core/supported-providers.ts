export const SUPPORTED_AUTH_PROVIDERS = [
	"openai",
	"openai-codex",
	"google",
	"google-gemini-cli",
	"google-antigravity",
	"zai",
] as const;

const supportedAuthProviderSet = new Set<string>(SUPPORTED_AUTH_PROVIDERS);

export function isSupportedAuthProvider(provider: string): provider is (typeof SUPPORTED_AUTH_PROVIDERS)[number] {
	return supportedAuthProviderSet.has(provider);
}
