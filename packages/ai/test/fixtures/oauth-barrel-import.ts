import { getOAuthProviders as rootGetOAuthProviders, refreshOAuthToken as rootRefreshOAuthToken } from "@marsai-org/ai";
import {
	getOAuthProviders as oauthGetOAuthProviders,
	refreshOAuthToken as oauthRefreshOAuthToken,
} from "@marsai-org/ai/registry/oauth";
import "@marsai-org/ai/providers/anthropic";
import "@marsai-org/ai/auth-storage";

const publicExports = [rootGetOAuthProviders, rootRefreshOAuthToken, oauthGetOAuthProviders, oauthRefreshOAuthToken];

if (publicExports.some(value => !value)) {
	throw new Error("OAuth registry exports are unavailable");
}
