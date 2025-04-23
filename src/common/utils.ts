import Store from 'electron-store';
import { AuthConfig, ProxyConfig, Settings, DEFAULT_SETTINGS } from './types';

interface StoreSchema {
    auth: AuthConfig | null;
    proxy: ProxyConfig | null;
    lastServer: string | null;
    settings: Settings;
}

// Cast the store instance to any initially to avoid TypeScript errors with methods
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
    return Date.now() + 5 * 60 * 1000 >= expiresAt;
}

export function saveProxyConfig(config: ProxyConfig): void {
    store.set(storeKeys.PROXY, config);
}

export function getProxyConfig(): ProxyConfig | null {
    return store.get(storeKeys.PROXY);
}

export function clearProxyConfig(): void {
    store.delete(storeKeys.PROXY);
}

export function getSettings(): Settings {
    return store.get(storeKeys.SETTINGS);
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

export async function refreshAuthToken(): Promise<boolean> {
    const authData = getAuthData();
    if (!authData?.refreshToken) return false;

    try {
        const response = await fetch('https://api.protonvpn.com/v2/auth/refresh', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ refreshToken: authData.refreshToken })
        });

        if (!response.ok) {
            throw new Error('Failed to refresh token');
        }

        const data = await response.json();
        saveAuthData({
            accessToken: data.accessToken,
            refreshToken: data.refreshToken,
            expiresAt: Date.now() + (data.expiresIn * 1000)
        });
        return true;
    } catch (error) {
        console.error('Token refresh failed:', error);
        clearAuthData();
        return false;
    }
}