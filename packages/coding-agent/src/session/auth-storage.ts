/**
 * Re-exports from @marsai-org/ai.
 * All credential storage types and the AuthStorage class now live in the ai package.
 */

export type {
	ApiKeyCredential,
	AuthCredential,
	AuthCredentialEntry,
	AuthCredentialStore,
	AuthStorageData,
	AuthStorageOptions,
	CredentialOrigin,
	CredentialOriginKind,
	OAuthAccountIdentity,
	OAuthAccountSummary,
	OAuthCredential,
	ResetCreditAccountStatus,
	ResetCreditRedeemOutcome,
	ResetCreditTarget,
	StoredAuthCredential,
} from "@marsai-org/ai";
export { AuthStorage, REMOTE_REFRESH_SENTINEL, SqliteAuthCredentialStore } from "@marsai-org/ai";
export type { SnapshotResponse } from "@marsai-org/ai/auth-broker/types";
