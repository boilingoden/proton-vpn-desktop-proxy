export interface ProxyServer {
    id: string;
    name: string;
    host: string;
    port: number;
    country?: string;
    protocol: 'http' | 'https' | 'socks4' | 'socks5';
    username?: string;
    password?: string;
}

export interface ProxyConfig {
    enabled: boolean;
    server: ProxyServer | null;
    autoSwitch: boolean;
    rules: ProxyRule[];
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
    proxyRules: ProxyRule[];
}

export const DEFAULT_SETTINGS: Settings = {
    autoConnect: {
        enabled: false
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
        GET: 'settings:get'
    }
} as const;