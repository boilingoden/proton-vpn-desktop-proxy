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

export function isCredentialRefreshNeeded(): boolean {
    const proxyConfig = getProxyConfig();
    if (!proxyConfig?.lastCredentialRefresh) return true;
    
    // Check if credentials are older than 45 minutes (75% of 1 hour token duration)
    const refreshAge = Date.now() - proxyConfig.lastCredentialRefresh;
    return refreshAge > 45 * 60 * 1000;
}