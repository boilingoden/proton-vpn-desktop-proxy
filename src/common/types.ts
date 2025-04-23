export interface VPNServer {
    id: string;
    name: string;
    host: string;
    port: number;
    country: string;
    load?: number;
    features?: string[];
}

export interface VPNConnectionConfig {
    server: VPNServer;
    protocol: 'udp' | 'tcp';
    username?: string;
    password?: string;
}

export interface AuthConfig {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
}

export interface ProxyConfig {
    host: string;
    port: number;
    protocol: string;
    enabled: boolean;
}

// IPC channel names
export const IPC_CHANNELS = {
    AUTH: {
        START: 'auth:start',
        COMPLETE: 'auth:complete',
        REFRESH: 'auth:refresh'
    },
    VPN: {
        CONNECT: 'vpn:connect',
        DISCONNECT: 'vpn:disconnect',
        STATUS: 'vpn:status'
    },
    PROXY: {
        SET: 'proxy:set',
        CLEAR: 'proxy:clear'
    }
} as const;