import { app, BrowserWindow, ipcMain, session, protocol } from 'electron';
import { join } from 'path';
import { IPC_CHANNELS, ProxySetConfig, ProxyAuthResponse } from '../common/types';
import { getAuthData, saveProxyConfig, clearProxyConfig, getSettings, refreshAuthToken, getProxyConfig } from '../common/utils';
import { ProtonVPNAPI } from '../common/api';
import { SettingsManager } from './settings';
import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { RequestInit } from 'node-fetch';

class MainProcess {
    private mainWindow: BrowserWindow | null = null;
    private authWindow: BrowserWindow | null = null;
    private proxyCheckInterval: NodeJS.Timeout | null = null;
    private lastProxyError: number = 0;
    private proxyRetryCount: number = 0;
    private settingsManager: SettingsManager;
    private static readonly MAX_RETRY_COUNT = 3;
    private static readonly MIN_RETRY_INTERVAL = 30000; // 30 seconds
    private static readonly PROXY_CHECK_INTERVAL = 60000; // 1 minute

    constructor() {
        this.settingsManager = new SettingsManager();
        app.whenReady().then(() => {
            this.setupApp();
            this.createMainWindow();
            this.setupIpcHandlers();
        });

        app.on('window-all-closed', () => {
            if (process.platform !== 'darwin') {
                this.cleanup();
                app.quit();
            }
        });

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) {
                this.createMainWindow();
            }
        });
    }

    private createMainWindow() {
        this.mainWindow = new BrowserWindow({
            width: 900,
            height: 680,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: join(__dirname, '../preload/preload.js')
            }
        });

        if (app.isPackaged) {
            this.mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
        } else {
            this.mainWindow.loadFile(join(__dirname, '../../dist/renderer/index.html'));
        }
    }

    private setupIpcHandlers() {
        // Auth handlers
        ipcMain.handle(IPC_CHANNELS.AUTH.START, async (_, authUrl: string) => {
            return this.handleOAuth(authUrl);
        });

        // Proxy handlers
        ipcMain.handle(IPC_CHANNELS.PROXY.SET, async (_, config: { 
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

        // Settings handlers
        ipcMain.handle(IPC_CHANNELS.SETTINGS.SAVE, (_, settings) => {
            return this.settingsManager.saveSettings(settings);
        });

        ipcMain.handle(IPC_CHANNELS.SETTINGS.GET, () => {
            return this.settingsManager.getSettings();
        });
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
                contextIsolation: true,
                webSecurity: true
            },
            parent: this.mainWindow || undefined,
            modal: true
        });

        // Register the custom protocol handler
        if (!app.isDefaultProtocolClient('protonvpn')) {
            app.setAsDefaultProtocolClient('protonvpn');
        }

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
            this.authWindow?.webContents.setWindowOpenHandler(({ url }) => {
                if (url.startsWith('protonvpn://')) {
                    handleRedirect(url);
                    return { action: 'deny' };
                }
                return { action: 'allow' };
            });

            this.authWindow?.on('closed', () => {
                this.authWindow = null;
                resolve(null);
            });
        });
    }

    private setupApp() {
        // Register protocol handler
        if (!app.isDefaultProtocolClient('protonvpn')) {
            app.setAsDefaultProtocolClient('protonvpn');
        }

        // Setup proxy protocol handlers
        protocol.registerHttpProtocol('proxy', (request, callback) => {
            callback({
                url: request.url.replace('proxy://', 'http://'),
                method: request.method,
                session: session.defaultSession
            });
        });
    }

    private cleanup() {
        if (this.proxyCheckInterval) {
            clearInterval(this.proxyCheckInterval);
            this.proxyCheckInterval = null;
        }
        this.clearSystemProxy();
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

    private startProxyMonitoring() {
        if (this.proxyCheckInterval) {
            clearInterval(this.proxyCheckInterval);
        }

        this.proxyCheckInterval = setInterval(async () => {
            const proxyStatus = await this.checkProxyStatus();
            if (!proxyStatus) {
                this.mainWindow?.webContents.send(IPC_CHANNELS.EVENTS.PROXY_CONNECTION_LOST);
            }
        }, MainProcess.PROXY_CHECK_INTERVAL);
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