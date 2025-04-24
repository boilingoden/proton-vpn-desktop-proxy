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

    constructor() {
        this.init();
    }

    private init() {
        app.whenReady().then(() => {
            this.createMainWindow();
            this.setupApp();
            
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

        // Set up IPC handlers
        this.setupIpcHandlers();
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

        // ... rest of the existing code ...
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

    private async checkLogicalStatus(serverId: string): Promise<boolean> {
        try {
            const authData = getAuthData();
            if (!authData?.accessToken) {
                this.updateProxyError({
                    type: ProxyErrorType.AUTH_FAILED,
                    message: 'Authentication token missing',
                    retryable: true
                });
                return false;
            }

            const response = await fetch(`https://api.protonvpn.com/vpn/v1/logicals?ID[]=${serverId}`, {
                headers: {
                    'Authorization': `Bearer ${authData.accessToken}`
                }
            });

            if (!response.ok) {
                this.updateProxyError({
                    type: ProxyErrorType.LOGICAL_ERROR,
                    message: 'Server status check failed',
                    httpStatus: response.status,
                    retryable: true
                });
                return false;
            }

            const data = await response.json();
            const isUp = data.LogicalServers?.[0]?.Status === 1;

            if (!isUp) {
                this.updateProxyError({
                    type: ProxyErrorType.SERVER_ERROR,
                    message: 'Server is down or maintenance',
                    retryable: false
                });
            }

            return isUp;
        } catch (error) {
            this.updateProxyError({
                type: ProxyErrorType.NETWORK_ERROR,
                message: 'Failed to check server status',
                retryable: true
            });
            return false;
        }
    }

    private async checkProxyStatus(): Promise<boolean> {
        const proxyConfig = getProxyConfig();
        if (!proxyConfig?.enabled) return false;

        try {
            // First check network connectivity
            if (!await this.checkNetworkConnectivity()) {
                return false;
            }

            const proxyUrl = `http://${proxyConfig.host}:${proxyConfig.port}`;
            const agent = new HttpsProxyAgent(proxyUrl);
            
            const headers: Record<string, string> = {};
            if (proxyConfig.username && proxyConfig.password) {
                headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(`${proxyConfig.username}:${proxyConfig.password}`).toString('base64');
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
                    timeout: 8000
                }).then(res => {
                    if (res.status === 401 || res.status === 407) {
                        throw new Error('AUTH_FAILED');
                    }
                    return res.ok;
                }).catch(err => {
                    if (err.message === 'AUTH_FAILED') {
                        this.updateProxyError({
                            type: ProxyErrorType.AUTH_FAILED,
                            message: 'Proxy authentication failed',
                            retryable: true
                        });
                    } else if (err.name === 'AbortError') {
                        this.updateProxyError({
                            type: ProxyErrorType.TIMEOUT,
                            message: 'Proxy connection timed out',
                            retryable: true
                        });
                    }
                    return false;
                })
            ));

            // Check logical status if enough time has passed
            const now = Date.now();
            if (proxyConfig.serverId && now - this.lastLogicalCheck >= MainProcess.LOGICAL_CHECK_INTERVAL) {
                this.lastLogicalCheck = now;
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
        } catch (error) {
            this.updateProxyError({
                type: ProxyErrorType.NETWORK_ERROR,
                message: 'Proxy status check failed',
                retryable: true
            });
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
                if (!proxyConfig?.enabled) return;

                // Check if credentials need refresh
                if (isCredentialRefreshNeeded()) {
                    this.mainWindow?.webContents.send(IPC_CHANNELS.EVENTS.CREDENTIALS_EXPIRED);
                    return;
                }

                const proxyStatus = await this.checkProxyStatus();
                if (!proxyStatus) {
                    const now = Date.now();
                    if (now - this.lastProxyError > MainProcess.MIN_RETRY_INTERVAL) {
                        this.lastProxyError = now;
                        this.proxyRetryCount++;
                        
                        if (this.proxyRetryCount <= MainProcess.MAX_RETRY_COUNT) {
                            this.mainWindow?.webContents.send(IPC_CHANNELS.EVENTS.PROXY_CONNECTION_LOST, proxyConfig.lastError);
                        } else {
                            // Force disconnect after max retries
                            await this.clearSystemProxy();
                            this.mainWindow?.webContents.send(IPC_CHANNELS.EVENTS.PROXY_CONNECTION_LOST, {
                                type: ProxyErrorType.SERVER_ERROR,
                                message: 'Maximum retry attempts reached',
                                retryable: false
                            });
                        }
                    }
                } else {
                    // Reset error state on successful connection
                    this.proxyRetryCount = 0;
                    this.lastProxyError = 0;
                    if (proxyConfig.lastError) {
                        delete proxyConfig.lastError;
                        delete proxyConfig.retryCount;
                        saveProxyConfig(proxyConfig);
                    }
                }
            } catch (error) {
                console.error('Proxy monitoring error:', error);
            }
        }, MainProcess.PROXY_CHECK_INTERVAL);

        // Monitor network connectivity changes
        if (app.on) {
            app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
                if (url.startsWith('https://api.protonvpn.com')) {
                    event.preventDefault();
                    callback(true);
                } else {
                    callback(false);
                }
            });
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
            const proxyRules = `http=${config.host}:${config.port};https=${config.host}:${config.port}`;
            
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

            // Cache the credentials and save config
            if (config.username && config.password) {
                cacheCredentials({
                    username: config.username,
                    password: config.password,
                    expiresIn: 3600 // Standard 1-hour token
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
            console.error('Failed to set system proxy:', error);
            return false;
        }
    }

    private async clearSystemProxy() {
        try {
            await session.defaultSession.setProxy({ proxyRules: '' });
            clearProxyConfig();
            
            if (this.proxyCheckInterval) {
                clearInterval(this.proxyCheckInterval);
                this.proxyCheckInterval = null;
            }
            
            return true;
        } catch (error) {
            console.error('Failed to clear system proxy:', error);
            return false;
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

    private initializeNetworkMonitoring() {
        // Check initial network state
        this.checkNetworkConnectivity();

        // Monitor network interface changes
        const getInterfacesString = () => JSON.stringify(networkInterfaces());
        let lastInterfaces = getInterfacesString();

        setInterval(() => {
            const currentInterfaces = getInterfacesString();
            if (currentInterfaces !== lastInterfaces) {
                lastInterfaces = currentInterfaces;
                this.checkNetworkConnectivity().then(online => {
                    if (online && this.networkState === 'offline') {
                        // Network restored - retry proxy connection
                        this.checkProxyStatus();
                    }
                });
            }
        }, 5000); // Check every 5 seconds
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
}

// Start the application
new MainProcess();