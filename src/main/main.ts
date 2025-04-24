import { app, BrowserWindow, ipcMain, session, protocol } from 'electron';
import { join } from 'path';
import { IPC_CHANNELS, ProxySetConfig, ProxyAuthResponse, ProxyError, ProxyErrorType } from '../common/types';
import { 
    getAuthData, 
    saveProxyConfig, 
    clearProxyConfig, 
    getSettings, 
    refreshAuthToken, 
    getProxyConfig,
    isCredentialRefreshNeeded,
    cacheCredentials
} from '../common/utils';
import { ProtonVPNAPI } from '../common/api';
import { SettingsManager } from './settings';
import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { RequestInit } from 'node-fetch';
import { networkInterfaces } from 'os';

class MainProcess {
    private mainWindow: BrowserWindow | null = null;
    private authWindow: BrowserWindow | null = null;
    private proxyCheckInterval: NodeJS.Timeout | null = null;
    private lastProxyError: number = 0;
    private proxyRetryCount: number = 0;
    private settingsManager: SettingsManager = new SettingsManager();
    private lastLogicalCheck: number = 0;
    private lastNetworkCheck: number = 0;
    private networkState: 'online' | 'offline' = 'online';
    private static readonly MAX_RETRY_COUNT = 3;
    private static readonly MIN_RETRY_INTERVAL = 30000; // 30 seconds
    private static readonly PROXY_CHECK_INTERVAL = 15000; // 15 seconds
    private static readonly LOGICAL_CHECK_INTERVAL = 300000; // 5 minutes
    private static readonly NETWORK_CHECK_INTERVAL = 10000; // 10 seconds
    private networkMonitoringInitialized = false;

    constructor() {
        this.init();
    }

    private init() {
        app.whenReady().then(() => {
            this.createMainWindow();
            this.setupApp();
            this.setupIpcHandlers();
            
            app.on('activate', () => {
                if (BrowserWindow.getAllWindows().length === 0) {
                    this.createMainWindow();
                }
            });

            // Handle auto-connect if enabled
            this.handleAutoConnect();
        });

        app.on('window-all-closed', () => {
            if (process.platform !== 'darwin') {
                this.cleanup();
                app.quit();
            }
        });
    }

    private createMainWindow() {
        this.mainWindow = new BrowserWindow({
            width: 900,
            height: 700,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: join(__dirname, '../../dist/preload/preload.js')
            },
            backgroundColor: '#1c1b24',
            show: false
        });

        // Load the index.html file from webpack build
        this.mainWindow.loadFile(join(__dirname, '../../dist/renderer/index.html'));

        // Enable DevTools in development
        if (process.env.NODE_ENV === 'development') {
            this.mainWindow.webContents.openDevTools();
        }

        // Show window when ready
        this.mainWindow.once('ready-to-show', () => {
            this.mainWindow?.show();
        });
    }

    private handleAuthWindowEvents(authWindow: BrowserWindow) {
        // Handle actual redirect after login
        authWindow.webContents.on('did-navigate', (event, url) => {
            if (url.startsWith('https://account.protonvpn.com/callback')) {
                if (this.mainWindow) {
                    this.mainWindow.webContents.send(IPC_CHANNELS.AUTH.CALLBACK, url);
                }
                authWindow.close();
            }
        });

        // Also handle hash-based redirects
        authWindow.webContents.on('did-navigate-in-page', (event, url) => {
            if (url.startsWith('https://account.protonvpn.com/callback')) {
                if (this.mainWindow) {
                    this.mainWindow.webContents.send(IPC_CHANNELS.AUTH.CALLBACK, url);
                }
                authWindow.close();
            }
        });

        // Handle window closed without auth
        authWindow.on('closed', () => {
            this.authWindow = null;
        });
    }

    private setupIpcHandlers() {
        ipcMain.handle(IPC_CHANNELS.PROXY.SET, async (_event, config) => {
            return await this.setSystemProxy(config);
        });

        ipcMain.handle(IPC_CHANNELS.PROXY.CLEAR, async () => {
            return await this.clearSystemProxy();
        });

        ipcMain.handle(IPC_CHANNELS.PROXY.STATUS, async () => {
            return await this.checkProxyStatus();
        });

        // Update auth handler
        ipcMain.handle(IPC_CHANNELS.AUTH.START, (_event, authUrl) => {
            if (this.authWindow) {
                this.authWindow.focus();
                return;
            }

            this.authWindow = new BrowserWindow({
                width: 800,
                height: 700,
                parent: this.mainWindow || undefined,
                modal: true,
                webPreferences: {
                    nodeIntegration: false,
                    contextIsolation: true,
                    webSecurity: true
                }
            });

            this.handleAuthWindowEvents(this.authWindow);
            return this.authWindow.loadURL(authUrl);
        });

        // ...rest of existing handlers...
    }

    private async updateProxyError(error: ProxyError) {
        const config = getProxyConfig();
        if (config) {
            config.lastError = error;
            config.retryCount = (config.retryCount || 0) + 1;
            saveProxyConfig(config);
        }
    }

    private async checkNetworkConnectivity(): Promise<boolean> {
        try {
            const now = Date.now();
            // Only check network every NETWORK_CHECK_INTERVAL ms
            if (now - this.lastNetworkCheck < MainProcess.NETWORK_CHECK_INTERVAL) {
                return this.networkState === 'online';
            }

            this.lastNetworkCheck = now;
            await fetch('https://1.1.1.1', { timeout: 3000 });
            if (this.networkState === 'offline') {
                this.networkState = 'online';
                // Network restored - trigger proxy check
                await this.checkProxyStatus();
            }
            return true;
        } catch (error) {
            if (this.networkState === 'online') {
                this.networkState = 'offline';
                this.updateProxyError({
                    type: ProxyErrorType.NETWORK_ERROR,
                    message: 'Network connectivity lost',
                    retryable: true
                });
            }
            return false;
        }
    }

    private async setSystemProxy(config: { 
        host: string; 
        port: number;
        username?: string;
        password?: string;
        bypassList?: string[];
    }) {
        try {
            // Reset error tracking on new connection
            this.proxyRetryCount = 0;
            this.lastProxyError = 0;

            const settings = getSettings();
            const proxyHost = config.host;
            const proxyPort = config.port;
            
            // Format proxy rules
            const proxyRules = `http=${proxyHost}:${proxyPort};https=${proxyHost}:${proxyPort}`;
            
            // Setup bypass list with proper security
            const proxyBypassRules = settings.killSwitch ? [
                'localhost',
                '127.0.0.1'
            ] : [
                'localhost',
                '127.0.0.1',
                '127.0.0.0/8',
                '10.0.0.0/8',
                '172.16.0.0/12',
                '192.168.0.0/16',
                '[::1]',
                '<local>',
                ...(config.bypassList || [])
            ];

            const proxyConfig: ProxySetConfig = {
                proxyRules,
                proxyBypassRules: proxyBypassRules.join(',')
            };

            if (config.username && config.password) {
                proxyConfig.username = config.username;
                proxyConfig.password = config.password;
            }

            await session.defaultSession.setProxy(proxyConfig);
            
            // Cache credentials and save config
            if (config.username && config.password) {
                cacheCredentials({
                    username: config.username,
                    password: config.password,
                    expiresIn: 3600
                });
            }

            saveProxyConfig({ 
                ...config, 
                protocol: 'http', 
                enabled: true 
            });

            // Start monitoring with shorter interval for faster response
            if (!this.proxyCheckInterval) {
                this.startProxyMonitoring();
            }

            return true;
        } catch (error) {
            console.error('Failed to set proxy:', error);
            return false;
        }
    }

    private async checkProxyStatus(): Promise<boolean> {
        const proxyConfig = getProxyConfig();
        if (!proxyConfig?.enabled) return false;

        try {
            // First check network connectivity
            if (!await this.checkNetworkConnectivity()) {
                this.updateProxyError({
                    type: ProxyErrorType.NETWORK_ERROR,
                    message: 'Network connectivity issues',
                    retryable: true
                });
                return false;
            }

            // Create proxy agent for requests
            const proxyUrl = `http://${proxyConfig.host}:${proxyConfig.port}`;
            const agent = new HttpsProxyAgent(proxyUrl);
            
            const headers: Record<string, string> = {};
            if (proxyConfig.username && proxyConfig.password) {
                headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(
                    `${proxyConfig.username}:${proxyConfig.password}`
                ).toString('base64');
            }

            // Test multiple endpoints in parallel with timeout
            const testUrls = [
                'https://api.protonvpn.com/vpn/location',
                'https://protonvpn.com',
                'https://api.protonvpn.com/vpn/v1/browser/token'
            ];

            const results = await Promise.all(testUrls.map(url => 
                fetch(url, {
                    agent,
                    headers,
                    timeout: 10000
                }).then(() => true).catch(() => false)
            ));

            // Check logical status after basic connectivity
            if (results.some(Boolean)) {
                if (proxyConfig.serverId) {
                    if (!await this.checkLogicalStatus(proxyConfig.serverId)) {
                        return false;
                    }
                }

                const isWorking = results.filter(Boolean).length >= 2;
                if (!isWorking) {
                    this.updateProxyError({
                        type: ProxyErrorType.SERVER_ERROR,
                        message: 'Proxy endpoints unreachable',
                        retryable: true
                    });
                }
                return isWorking;
            }

            this.updateProxyError({
                type: ProxyErrorType.SERVER_ERROR,
                message: 'All proxy endpoints unreachable',
                retryable: true
            });
            return false;

        } catch (error) {
            this.updateProxyError({
                type: ProxyErrorType.NETWORK_ERROR,
                message: 'Proxy status check failed',
                retryable: true
            });
            return false;
        }
    }

    private async checkLogicalStatus(serverId: string): Promise<boolean> {
        try {
            const now = Date.now();
            // Rate limit logical checks
            if (now - this.lastLogicalCheck < MainProcess.LOGICAL_CHECK_INTERVAL) {
                return true;
            }
            this.lastLogicalCheck = now;

            const isUp = await ProtonVPNAPI.checkServerStatus(serverId);
            if (!isUp) {
                this.updateProxyError({
                    type: ProxyErrorType.LOGICAL_ERROR,
                    message: 'Server unavailable',
                    retryable: true
                });
                return false;
            }
            return true;
        } catch (error) {
            console.error('Logical status check failed:', error);
            return false;
        }
    }

    private startProxyMonitoring() {
        if (this.proxyCheckInterval) {
            clearInterval(this.proxyCheckInterval);
        }

        this.proxyCheckInterval = setInterval(async () => {
            try {
                const proxyConfig = getProxyConfig();
                if (!proxyConfig?.enabled) {
                    this.stopProxyMonitoring();
                    return;
                }

                const isWorking = await this.checkProxyStatus();
                
                if (!isWorking) {
                    this.proxyRetryCount++;
                    
                    if (this.proxyRetryCount >= MainProcess.MAX_RETRY_COUNT) {
                        if (this.mainWindow) {
                            this.mainWindow.webContents.send(IPC_CHANNELS.EVENTS.PROXY_CONNECTION_LOST, {
                                type: ProxyErrorType.SERVER_ERROR,
                                message: 'Maximum retry attempts reached',
                                retryable: false
                            });
                        }
                        this.stopProxyMonitoring();
                    }
                } else {
                    // Reset error state on successful connection
                    this.proxyRetryCount = 0;
                    this.lastProxyError = 0;
                    
                    const config = getProxyConfig();
                    if (config?.lastError) {
                        delete config.lastError;
                        delete config.retryCount;
                        saveProxyConfig(config);
                    }
                }
            } catch (error) {
                console.error('Proxy monitoring error:', error);
            }
        }, MainProcess.PROXY_CHECK_INTERVAL);

        // Setup network state monitoring
        if (!this.networkMonitoringInitialized) {
            this.initializeNetworkMonitoring();
        }
    }

    private initializeNetworkMonitoring() {
        this.networkMonitoringInitialized = true;
        
        if (app.on) {
            app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
                if (url.startsWith('https://api.protonvpn.com')) {
                    event.preventDefault();
                    callback(true);
                    return;
                }
                callback(false);
            });
        }

        session.defaultSession.on('will-download', () => {
            this.checkNetworkConnectivity();
        });

        // Monitor main window network state
        if (this.mainWindow) {
            this.mainWindow.webContents.on('did-fail-load', (_event, _code, description) => {
                if (description.includes('ERR_INTERNET_DISCONNECTED') ||
                    description.includes('ERR_NETWORK_CHANGED')) {
                    this.networkState = 'offline';
                    this.updateProxyError({
                        type: ProxyErrorType.NETWORK_ERROR,
                        message: 'Network connection lost',
                        retryable: true
                    });
                }
            });
        }
    }

    private stopProxyMonitoring() {
        if (this.proxyCheckInterval) {
            clearInterval(this.proxyCheckInterval);
            this.proxyCheckInterval = null;
        }
    }

    private async handleAutoConnect() {
        const settings = getSettings();
        if (!settings.autoConnect.enabled || !settings.autoConnect.serverId) {
            return;
        }

        try {
            const authData = getAuthData();
            if (!authData) return;

            if (await refreshAuthToken()) {
                const servers = await ProtonVPNAPI.getServers();
                const server = servers.find((s: { id: string }) => s.id === settings.autoConnect.serverId);
                
                if (server && server.status === 'online') {
                    const response = await fetch('https://api.protonvpn.com/v2/vpn/browser/token?Duration=3600', {
                        headers: {
                            'Authorization': `Bearer ${authData.accessToken}`
                        }
                    });

                    if (response.ok) {
                        const data = await response.json() as ProxyAuthResponse;
                        if (data.Code === 1000) {
                            await this.setSystemProxy({
                                host: server.host,
                                port: server.port,
                                username: data.Username,
                                password: data.Password,
                                bypassList: []
                            });
                        }
                    }
                }
            }
        } catch (error) {
            console.error('Auto-connect failed:', error);
        }
    }

    private setupApp() {
        // Register protocol handler
        if (!app.isDefaultProtocolClient('protonvpn')) {
            app.setAsDefaultProtocolClient('protonvpn');
        }

        // Handle network state changes
        app.on('session-created', (session) => {
            session.on('will-download', (event, item, webContents) => {
                // Update network state on download events
                this.checkNetworkConnectivity();
            });
        });

        // Monitor online/offline status
        app.whenReady().then(() => {
            const win = this.mainWindow;
            if (win) {
                win.webContents.on('did-fail-load', (_event, _code, description) => {
                    if (description.includes('ERR_INTERNET_DISCONNECTED') ||
                        description.includes('ERR_NETWORK_CHANGED')) {
                        this.networkState = 'offline';
                        this.updateProxyError({
                            type: ProxyErrorType.NETWORK_ERROR,
                            message: 'Network connection lost',
                            retryable: true
                        });
                    }
                });
            }
        });

        // Setup proxy protocol handlers with correct format
        protocol.registerHttpProtocol('proxy', (request, callback) => {
            const proxyConfig = getProxyConfig();
            if (!proxyConfig?.enabled) {
                callback({
                    url: request.url.replace('proxy://', 'http://'),
                    method: request.method || 'GET',
                    session: session.defaultSession
                });
                return;
            }

            // Handle proxy authentication via session configuration instead
            callback({
                url: request.url.replace('proxy://', 'http://'),
                method: request.method || 'GET',
                session: session.defaultSession
            });
        });

        // Initialize monitoring
        this.initializeNetworkMonitoring();
    }

    private cleanup() {
        // Clear all intervals
        if (this.proxyCheckInterval) {
            clearInterval(this.proxyCheckInterval);
            this.proxyCheckInterval = null;
        }

        // Clear proxy config
        this.clearSystemProxy().catch(error => {
            console.error('Failed to clear proxy on cleanup:', error);
        });

        // Reset network state
        this.networkState = 'online';
        this.lastNetworkCheck = 0;
        this.lastProxyError = 0;
        this.proxyRetryCount = 0;
    }

    private async clearSystemProxy(): Promise<boolean> {
        try {
            await session.defaultSession.setProxy({});
            clearProxyConfig();
            this.stopProxyMonitoring();
            return true;
        } catch (error: unknown) {
            const err = error as Error;
            console.error('Failed to clear proxy:', err.message);
            return false;
        }
    }
}

// Start the application
new MainProcess();