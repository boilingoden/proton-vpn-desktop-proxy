export enum ConnectionState {
    CONNECTED = 'connected',
    CONNECTING = 'connecting',
    DISCONNECTED = 'disconnected',
    ERROR = 'error'
}

export enum ErrorCode {
    NETWORK_CHANGED = 'net::ERR_NETWORK_CHANGED',
    NETWORK_IO_SUSPENDED = 'net::ERR_NETWORK_IO_SUSPENDED',
    TUNNEL_CONNECTION_FAILED = 'net::ERR_TUNNEL_CONNECTION_FAILED',
    PROXY_CONNECTION_FAILED = 'net::ERR_PROXY_CONNECTION_FAILED',
    PROXY_AUTH_FAILED = 'net::ERR_PROXY_AUTH_REQUIRED',
    TIMED_OUT = 'net::ERR_TIMED_OUT',
    CONNECTION_RESET = 'net::ERR_CONNECTION_RESET',
    CONNECTION_REFUSED = 'net::ERR_CONNECTION_REFUSED'
}

export enum ProxyErrorType {
    AUTH_FAILED = 'auth_failed',
    NETWORK_ERROR = 'network_error',
    TIMEOUT = 'timeout',
    SERVER_ERROR = 'server_error',
    LOGICAL_ERROR = 'logical_error',
    CREDENTIAL_ERROR = 'credential_error'
}

export interface ProxyError {
    type: ProxyErrorType;
    code?: string;
    message: string;
    httpStatus?: number;
    retryable: boolean;
    retryAfter?: number;
}

export interface ProxyServer {
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

export interface VPNServer extends ProxyServer {
    logicalId?: string;
    score?: number;
    entryIp?: string;
    exitIp?: string;
    domain?: string;
    x25519PublicKey?: string;
    generation?: number;
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
    serverId?: string;
    lastError?: ProxyError;
    retryCount?: number;
    retryBackoff?: number;
    lastRetryTime?: number;
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
        lastServer?: string;
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
    retrySettings?: {
        maxAttempts: number;
        baseDelay: number;
        maxDelay: number;
    };
}

export interface AuthConfig {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    sessionId?: string;
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
    proxyRules: [],
    retrySettings: {
        maxAttempts: 4,
        baseDelay: 500,
        maxDelay: 12000
    }
};

export const IPC_CHANNELS = {
    PROXY: {
        SET: 'proxy:set',
        CLEAR: 'proxy:clear',
        STATUS: 'proxy:status'
    },
    AUTH: {
        START: 'auth:start',
        CALLBACK: 'auth:callback', 
        REFRESH: 'auth:refresh',
        STATUS: 'auth:status'
    },
    EVENTS: {
        PROXY_CONNECTION_LOST: 'proxy-connection-lost',
        CREDENTIALS_EXPIRED: 'credentials-expired',
        SETTINGS_CHANGED: 'settings-changed',
        AUTH_SUCCESS: 'auth:success',
        AUTH_FAILED: 'auth:failed'
    }
} as const;