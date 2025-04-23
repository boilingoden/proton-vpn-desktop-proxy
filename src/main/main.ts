import { app, BrowserWindow, ipcMain, session } from 'electron';
import { join } from 'path';
import { IPC_CHANNELS, ProxySetConfig, ProxyAuthResponse } from '../common/types';
import { getAuthData, saveProxyConfig, clearProxyConfig, getSettings, refreshAuthToken, getProxyConfig } from '../common/utils';
import { ProtonVPNAPI } from '../common/api';
import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { RequestInit } from 'node-fetch';

class MainProcess {
    private mainWindow: BrowserWindow | null = null;
    private authWindow: BrowserWindow | null = null;
    private proxyCheckInterval: NodeJS.Timeout | null = null;
    private lastProxyError: number = 0;
    private proxyRetryCount: number = 0;
    private static readonly MAX_RETRY_COUNT = 3;
    private static readonly MIN_RETRY_INTERVAL = 30000; // 30 seconds
    private static readonly PROXY_CHECK_INTERVAL = 60000; // 1 minute

    constructor() {
        this.setupApp();
    }

    private setupApp() {
        if (process.platform === 'linux') {
            app.disableHardwareAcceleration();
            if (!process.env.DISPLAY) {
                console.log('No display available - running in headless mode');
                return;
            }
        }

        app.on('ready', async () => {
            this.createMainWindow();
            this.setupIpcHandlers();
            await this.handleAutoConnect();
            this.startProxyMonitoring();
        });

        app.on('window-all-closed', () => {
            if (process.platform !== 'darwin') {
                app.quit();
            }
        });

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) {
                this.createMainWindow();
            }
        });

        app.on('before-quit', () => {
            this.cleanup();
        });
    }

    private cleanup() {
        if (this.proxyCheckInterval) {
            clearInterval(this.proxyCheckInterval);
            this.proxyCheckInterval = null;
        }
        
        // Clear proxy settings when quitting if kill switch is not enabled
        const settings = getSettings();
        if (!settings.killSwitch) {
            this.clearSystemProxy().catch(console.error);
        }
    }

    private async retryProxyConnection(force: boolean = false): Promise<boolean> {
        const now = Date.now();
        if (!force && (
            now - this.lastProxyError < MainProcess.MIN_RETRY_INTERVAL || 
            this.proxyRetryCount >= MainProcess.MAX_RETRY_COUNT
        )) {
            return false;
        }

        try {
            const authData = getAuthData();
            if (!authData?.accessToken) {
                if (authData?.refreshToken) {
                    const refreshed = await refreshAuthToken();
                    if (!refreshed) {
                        return false;
                    }
                    return this.retryProxyConnection(true);
                }
                return false;
            }

            const response = await fetch('https://api.protonvpn.com/v2/vpn/browser/token?Duration=3600', {
                headers: {
                    'Authorization': `Bearer ${authData.accessToken}`
                }
            });

            if (!response.ok) {
                if (response.status === 401) {
                    if (await refreshAuthToken()) {
                        return this.retryProxyConnection(true);
                    }
                }
                return false;
            }

            const data = await response.json() as ProxyAuthResponse;
            if (data.Code !== 1000) return false;

            const proxyConfig = getProxyConfig();
            if (!proxyConfig?.enabled) return false;

            await this.setSystemProxy({
                host: proxyConfig.host,
                port: proxyConfig.port,
                username: data.Username,
                password: data.Password,
                bypassList: proxyConfig.bypassList
            });

            this.proxyRetryCount = 0;
            this.lastProxyError = 0;
            return true;
        } catch (error) {
            console.error('Proxy retry failed:', error);
            this.lastProxyError = now;
            this.proxyRetryCount++;
            return false;
        }
    }

    private startProxyMonitoring() {
        if (this.proxyCheckInterval) {
            clearInterval(this.proxyCheckInterval);
        }

        this.proxyCheckInterval = setInterval(async () => {
            const proxyConfig = getProxyConfig();
            if (!proxyConfig?.enabled) return;

            try {
                const proxyUrl = `http://${proxyConfig.host}:${proxyConfig.port}`;
                const agent = new HttpsProxyAgent(proxyUrl);
                
                const headers: Record<string, string> = {};
                if (proxyConfig.username && proxyConfig.password) {
                    headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(`${proxyConfig.username}:${proxyConfig.password}`).toString('base64');
                }

                const fetchOptions: RequestInit = {
                    agent,
                    headers
                };

                const testResponse = await fetch('https://api.protonvpn.com/vpn/location', fetchOptions);
                if (!testResponse.ok) {
                    throw new Error('Proxy connection test failed');
                }

                // Reset retry count on successful connection
                this.proxyRetryCount = 0;
                this.lastProxyError = 0;
            } catch (error) {
                console.error('Proxy connection lost:', error);
                
                const recovered = await this.retryProxyConnection();
                if (!recovered) {
                    await this.clearSystemProxy();
                    this.mainWindow?.webContents.send(IPC_CHANNELS.EVENTS.PROXY_CONNECTION_LOST);
                }
            }
        }, MainProcess.PROXY_CHECK_INTERVAL);
    }

    private createMainWindow() {
        try {
            this.mainWindow = new BrowserWindow({
                width: 900,
                height: 600,
                webPreferences: {
                    nodeIntegration: true,
                    contextIsolation: false
                },
                show: false
            });

            this.mainWindow.once('ready-to-show', () => {
                this.mainWindow?.show();
            });

            this.mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
        } catch (error) {
            console.error('Failed to create window:', error);
        }
    }

    private setupIpcHandlers() {
        ipcMain.handle(IPC_CHANNELS.AUTH.START, async (_event, authUrl: string) => {
            return this.handleOAuth(authUrl);
        });

        ipcMain.handle(IPC_CHANNELS.PROXY.SET, async (_event, config: { 
            host: string; 
            port: number;
            username?: string;
            password?: string;
            bypassList?: string[];
        }) => {
            return this.setSystemProxy(config);
        });

        ipcMain.handle(IPC_CHANNELS.PROXY.CLEAR, async () => {
            return this.clearSystemProxy();
        });

        ipcMain.handle(IPC_CHANNELS.PROXY.STATUS, async () => {
            return this.checkProxyStatus();
        });
    }

    private async checkProxyStatus(): Promise<boolean> {
        const proxyConfig = getProxyConfig();
        if (!proxyConfig?.enabled) return false;

        try {
            const proxyUrl = `http://${proxyConfig.host}:${proxyConfig.port}`;
            const agent = new HttpsProxyAgent(proxyUrl);
            
            const headers: Record<string, string> = {};
            if (proxyConfig.username && proxyConfig.password) {
                headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(`${proxyConfig.username}:${proxyConfig.password}`).toString('base64');
            }

            const fetchOptions: RequestInit = {
                agent,
                headers
            };

            const testResponse = await fetch('https://api.protonvpn.com/vpn/location', fetchOptions);
            return testResponse.ok;
        } catch (error) {
            console.error('Proxy status check failed:', error);
            return false;
        }
    }

    private async handleOAuth(authUrl: string): Promise<string | null> {
        if (this.authWindow) {
            this.authWindow.close();
        }

        this.authWindow = new BrowserWindow({
            width: 800,
            height: 600,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true
            }
        });

        return new Promise((resolve) => {
            this.authWindow?.loadURL(authUrl);

            const handleRedirect = (url: string) => {
                if (url.startsWith('protonvpn://')) {
                    resolve(url);
                    this.authWindow?.close();
                }
            };

            this.authWindow?.webContents.on('will-redirect', (_event, url) => handleRedirect(url));
            this.authWindow?.webContents.on('will-navigate', (_event, url) => handleRedirect(url));

            this.authWindow?.on('closed', () => {
                this.authWindow = null;
                resolve(null);
            });
        });
    }

    private async setSystemProxy(config: { 
        host: string; 
        port: number;
        username?: string;
        password?: string;
        bypassList?: string[];
    }) {
        try {
            const settings = getSettings();
            const proxyRules = `http=${config.host}:${config.port};https=${config.host}:${config.port}`;
            
            // Use stricter bypass rules if kill switch is enabled
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

            saveProxyConfig({ 
                ...config, 
                protocol: 'http', 
                enabled: true 
            });

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
}

// Start the application
new MainProcess();