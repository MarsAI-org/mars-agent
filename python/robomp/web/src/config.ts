// Configuration injected by FastAPI at request time. The server replaces the
// `__ROBOMP_CONFIG__` sentinel in `static/index.html` with a JSON blob so the
// SPA never needs to make an extra round-trip just to learn whether the
// trigger surface is enabled.

export interface AppConfig {
  replayEnabled: boolean;
}

const REPLAY_TOKEN_STORAGE_KEY = "robomp_replay_token";

function readConfig(): AppConfig {
  const node = document.getElementById("robomp-config");
  const text = node?.textContent?.trim();
  if (!text || text === "__ROBOMP_CONFIG__") {
    return { replayEnabled: false };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object") {
      return { replayEnabled: false };
    }
    const record = parsed as Record<string, unknown>;
    return {
      replayEnabled: Boolean(record.replayEnabled),
    };
  } catch {
    return { replayEnabled: false };
  }
}

export const CONFIG: AppConfig = readConfig();

export function getReplayToken(): string {
  try {
    return window.sessionStorage.getItem(REPLAY_TOKEN_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setReplayToken(token: string): void {
  try {
    if (token) {
      window.sessionStorage.setItem(REPLAY_TOKEN_STORAGE_KEY, token);
    } else {
      window.sessionStorage.removeItem(REPLAY_TOKEN_STORAGE_KEY);
    }
  } catch {
    // Ignore storage errors in restricted browsing contexts.
  }
}

export function getAuthHeaders(): Record<string, string> {
  if (!CONFIG.replayEnabled) return {};
  const token = getReplayToken();
  return token ? { "X-Robomp-Replay-Token": token } : {};
}

export const AUTH_HEADERS: Readonly<Record<string, string>> = Object.freeze(getAuthHeaders());

export const POLL_INTERVAL_MS = 3000;
