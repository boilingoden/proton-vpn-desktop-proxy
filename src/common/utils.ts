import Store from 'electron-store';
import { AuthConfig, ProxyConfig } from './types';

interface StoreSchema {
    auth: AuthConfig | null;
    proxy: ProxyConfig | null;
    lastServer: string | null;
}

// Cast the store instance to any initially to avoid TypeScript errors with methods
const store = new Store<StoreSchema>({
    defaults: {
        auth: null,
        proxy: null,
        lastServer: null
    }
}) as any;

export const storeKeys = {
    AUTH: 'auth' as const,
    PROXY: 'proxy' as const,
    LAST_SERVER: 'lastServer' as const
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