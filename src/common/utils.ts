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

export function isTokenExpired(expiresAt: number): boolean {
    // Consider token expired 5 minutes before actual expiry
    return Date.now() + 5 * 60 * 1000 >= expiresAt;
}

export function clearAuthData(): void {
    store.delete(storeKeys.AUTH);
}

export function clearCredentials(): void {
    cachedCredentials = null;
    if (credentialNextFetching) {
        clearTimeout(credentialNextFetching);
        credentialNextFetching = null;
    }
}

export function shouldPreemptivelyRefresh(): boolean {
    const checkResult = checkCredentials();
    return checkResult.nearingExpiry && !checkResult.expired;
}

export async function refreshAuthToken(): Promise<boolean> {
    try {
        const authData = getAuthData();
        if (!authData?.refreshToken) {
            return false;
        }

        const response = await fetch('https://api.protonvpn.com/v2/auth/refresh', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-pm-appversion': 'Other'
            },
            body: JSON.stringify({ 
                RefreshToken: authData.refreshToken,
                ResponseType: 'token',
                GrantType: 'refresh_token'
            })
        });

        if (!response.ok) {
            clearAuthData();
            return false;
        }

        const data = await response.json();
        if (data.Code !== 1000) {
            clearAuthData();
            return false;
        }

        const newAuthData: AuthConfig = {
            accessToken: data.AccessToken,
            refreshToken: data.RefreshToken,
            expiresAt: Date.now() + (data.ExpiresIn * 1000)
        };

        saveAuthData(newAuthData);
        return true;
    } catch (error) {
        console.error('Failed to refresh token:', error);
        clearAuthData();
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
    halfLife: number;
    credentials: {
        Username: string;
        Password: string;
        Expire: number;
    };
}

let cachedCredentials: CredentialsCacheItem | null = null;
let credentialNextFetching: NodeJS.Timeout | null = null;
const CREDENTIAL_CHECK_INTERVAL = 1000; // Check every second
const CREDENTIAL_REFRESH_MARGIN = 0.1; // Refresh at 90% of expiry time like extension
let lastCredentialCheck = 0;

export function cacheCredentials(credentials: { username: string; password: string; expiresIn: number }) {
    const now = Date.now();
    const expiryTime = now + (credentials.expiresIn * 1000);
    cachedCredentials = {
        time: expiryTime,
        halfLife: now + (credentials.expiresIn * 500), // Half of expiry time
        credentials: {
            Username: credentials.username,
            Password: credentials.password,
            Expire: credentials.expiresIn
        }
    };
}

export function getCachedCredentials(): CredentialsCacheItem | null {
    if (!cachedCredentials) {
        return null;
    }

    const now = Date.now();
    // Check if expired
    if (now >= cachedCredentials.time) {
        clearCredentials();
        return null;
    }

    return cachedCredentials;
}

interface CredentialsCheckResult {
    valid: boolean;
    expired: boolean;
    needsRefresh: boolean;
    nearingExpiry: boolean;
}

export function checkCredentials(): CredentialsCheckResult {
    const now = Date.now();
    // Rate limit credential checks
    if (now - lastCredentialCheck < CREDENTIAL_CHECK_INTERVAL) {
        return { 
            valid: true, 
            expired: false, 
            needsRefresh: false,
            nearingExpiry: false 
        };
    }
    lastCredentialCheck = now;

    const cached = getCachedCredentials();
    if (!cached) {
        return { 
            valid: false, 
            expired: true, 
            needsRefresh: true,
            nearingExpiry: false 
        };
    }

    const timeUntilExpiry = cached.time - now;
    if (timeUntilExpiry <= 0) {
        return { 
            valid: false, 
            expired: true, 
            needsRefresh: true,
            nearingExpiry: false 
        };
    }

    // Calculate refresh time with 10% margin
    const refreshMargin = cached.credentials.Expire * 1000 * CREDENTIAL_REFRESH_MARGIN;
    const needsRefresh = timeUntilExpiry <= refreshMargin;
    const nearingExpiry = timeUntilExpiry <= refreshMargin * 2; // Additional warning threshold

    return {
        valid: true,
        expired: false,
        needsRefresh,
        nearingExpiry
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