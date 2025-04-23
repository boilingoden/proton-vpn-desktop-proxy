export interface ProxyServer {
    id: string;
    name: string;
    host: string;
    port: number;
    country?: string;
    protocol: 'http' | 'https' | 'socks4' | 'socks5';
    username?: string;
    password?: string;
    bypassList?: string[];
    status?: 'online' | 'offline' | 'maintenance';
    features?: string[];
    load?: number;
    entryCountry?: string;
    exitCountry?: string;
    tier?: number;
}

export interface VPNServer {
    id: string;
    name: string;
    host: string;
    port: number;
    country?: string;
    city?: string;
    protocol: 'http' | 'https' | 'socks4' | 'socks5';
    username?: string;
    password?: string;
    bypassList?: string[];
    status?: 'online' | 'offline' | 'maintenance';
    features?: string[];
    load?: number;
    entryCountry?: string;
    exitCountry?: string;
    tier?: number;
}

export interface ProxyConfig {
    enabled: boolean;
    host: string;
    port: number;
    protocol: 'http' | 'https';
    username?: string;
    password?: string;
    bypassList?: string[];
    lastCredentialRefresh?: number;
}

export interface ProxySetConfig {
    proxyRules: string;
    proxyBypassRules?: string;
    username?: string;
    password?: string;
}

export interface ProxyAuthResponse {
    Code: number;
    Username: string;
    Password: string;
    Expire: number;
}

export interface ProxyRule {
    pattern: string;
    server: ProxyServer | null;
}

export interface Settings {
    autoConnect: {
        enabled: boolean;
        serverId?: string;
    };
    killSwitch: boolean;
    protocol: 'udp' | 'tcp';
    dns: {
        custom: boolean;
        servers: string[];
    };
    splitTunneling: {
        enabled: boolean;
        mode: 'include' | 'exclude';
        apps: string[];
    };
    proxyRules: ProxyRule[];
}

export interface AuthConfig {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
}

export const DEFAULT_SETTINGS: Settings = {
    autoConnect: {
        enabled: false
    },
    killSwitch: false,
    protocol: 'udp',
    dns: {
        custom: false,
        servers: []
    },
    splitTunneling: {
        enabled: false,
        mode: 'exclude',
        apps: []
    },
    proxyRules: []
};

export const IPC_CHANNELS = {
    PROXY: {
        SET: 'proxy:set',
        CLEAR: 'proxy:clear',
        STATUS: 'proxy:status'
    },
    SETTINGS: {
        SAVE: 'settings:save',
        GET: 'settings:get',
        APPLY: 'settings:apply'
    },
    AUTH: {
        START: 'auth:start',
        REFRESH: 'auth:refresh'
    },
    EVENTS: {
        PROXY_CONNECTION_LOST: 'proxy-connection-lost',
        CREDENTIALS_EXPIRED: 'credentials-expired',
        SETTINGS_CHANGED: 'settings-changed'
    }
} as const;