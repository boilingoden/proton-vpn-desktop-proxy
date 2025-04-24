import Store from 'electron-store';
import { AuthConfig, ProxyConfig, Settings, DEFAULT_SETTINGS } from './types';
import { ProtonVPNAPI } from './api';

interface StoreSchema {
    auth: AuthConfig | null;
    proxy: ProxyConfig | null;
    lastServer: string | null;
    settings: Settings;
}

const store = new Store<StoreSchema>({
    defaults: {
        auth: null,
        proxy: null,
        lastServer: null,
        settings: DEFAULT_SETTINGS
    }
}) as any;

export const storeKeys = {
    AUTH: 'auth' as const,
    PROXY: 'proxy' as const,
    LAST_SERVER: 'lastServer' as const,
    SETTINGS: 'settings' as const
};

export function saveAuthData(authData: AuthConfig): void {
    store.set(storeKeys.AUTH, authData);
}

export function getAuthData(): AuthConfig | null {
    return store.get(storeKeys.AUTH);
}

export function clearAuthData(): void {
    store.delete(storeKeys.AUTH);
}

export function isTokenExpired(expiresAt: number): boolean {
    // Consider token expired 5 minutes before actual expiry
    return Date.now() + 5 * 60 * 1000 >= expiresAt;
}

export async function refreshAuthToken(): Promise<boolean> {
    try {
        const authData = getAuthData();
        if (!authData?.refreshToken) {
            return false;
        }

        const newAuthData = await ProtonVPNAPI.refreshToken(authData.refreshToken);
        if (!newAuthData) {
            clearAuthData();
            return false;
        }

        saveAuthData(newAuthData);
        return true;
    } catch (error) {
        console.error('Failed to refresh token:', error);
        return false;
    }
}

export function saveProxyConfig(config: ProxyConfig): void {
    // Update lastCredentialRefresh when credentials change
    const currentConfig = getProxyConfig();
    if (!currentConfig || 
        currentConfig.username !== config.username || 
        currentConfig.password !== config.password) {
        config.lastCredentialRefresh = Date.now();
    }

    // Preserve error state and retry count if they exist
    if (currentConfig?.lastError) {
        config.lastError = currentConfig.lastError;
    }
    if (currentConfig?.retryCount) {
        config.retryCount = currentConfig.retryCount;
    }

    store.set(storeKeys.PROXY, config);
}

export function getProxyConfig(): ProxyConfig | null {
    return store.get(storeKeys.PROXY);
}

export function clearProxyConfig(): void {
    store.delete(storeKeys.PROXY);
}

export function getSettings(): Settings {
    return store.get(storeKeys.SETTINGS, DEFAULT_SETTINGS);
}

export function updateSettings(settings: Partial<Settings>): void {
    const currentSettings = getSettings();
    store.set(storeKeys.SETTINGS, {
        ...currentSettings,
        ...settings
    });
}

export function resetSettings(): void {
    store.set(storeKeys.SETTINGS, DEFAULT_SETTINGS);
}

export function saveLastServer(serverId: string): void {
    store.set(storeKeys.LAST_SERVER, serverId);
}

export function getLastServer(): string | null {
    return store.get(storeKeys.LAST_SERVER);
}

export interface CredentialsCacheItem {
    time: number;
    credentials: {
        Username: string;
        Password: string;
        Expire: number;
    };
}

let cachedCredentials: CredentialsCacheItem | null = null;

export function cacheCredentials(credentials: { username: string; password: string; expiresIn: number }) {
    cachedCredentials = {
        time: Date.now() + (credentials.expiresIn * 1000),
        credentials: {
            Username: credentials.username,
            Password: credentials.password,
            Expire: credentials.expiresIn
        }
    };
}

export function getCachedCredentials(): CredentialsCacheItem | null {
    if (!cachedCredentials || Date.now() >= cachedCredentials.time) {
        return null;
    }
    return cachedCredentials;
}

interface CredentialsCheckResult {
    valid: boolean;
    expired: boolean;
    needsRefresh: boolean;
}

let lastCredentialCheck = 0;
const CREDENTIAL_CHECK_INTERVAL = 1000; // Check every second
const CREDENTIAL_REFRESH_MARGIN = 0.1; // Refresh at 90% of expiry time like extension

export function checkCredentials(): CredentialsCheckResult {
    const now = Date.now();
    // Rate limit credential checks
    if (now - lastCredentialCheck < CREDENTIAL_CHECK_INTERVAL) {
        return { valid: true, expired: false, needsRefresh: false };
    }
    lastCredentialCheck = now;

    const cached = getCachedCredentials();
    if (!cached) {
        return { valid: false, expired: true, needsRefresh: true };
    }

    const timeUntilExpiry = cached.time - now;
    if (timeUntilExpiry <= 0) {
        return { valid: false, expired: true, needsRefresh: true };
    }

    // Calculate refresh time with 10% margin
    const refreshMargin = cached.credentials.Expire * 1000 * CREDENTIAL_REFRESH_MARGIN;
    const needsRefresh = timeUntilExpiry <= refreshMargin;

    return {
        valid: true,
        expired: false,
        needsRefresh
    };
}

export function isCredentialRefreshNeeded(): boolean {
    const checkResult = checkCredentials();
    return checkResult.needsRefresh || checkResult.expired;
}

export function getValidCredentials(): CredentialsCacheItem | null {
    const checkResult = checkCredentials();
    if (!checkResult.valid || checkResult.expired) {
        return null;
    }
    return getCachedCredentials();
}