import { app, BrowserWindow, ipcMain, session } from 'electron';
import { join } from 'path';
import { IPC_CHANNELS, VPNServer } from '../common/types';
import { saveAuthData, getAuthData, clearAuthData, saveProxyConfig, clearProxyConfig, getSettings, refreshAuthToken, getLastServer } from '../common/utils';
import { ProtonVPNAPI } from '../common/api';

class MainProcess {
    private mainWindow: BrowserWindow | null = null;
    private authWindow: BrowserWindow | null = null;

    constructor() {
        this.setupApp();
    }

    private setupApp() {
        // Handle Linux environments without X server
        if (process.platform === 'linux') {
            app.disableHardwareAcceleration();
            // If no display is available, don't create windows
            if (!process.env.DISPLAY) {
                console.log('No display available - running in headless mode');
                return;
            }
        }

        app.on('ready', async () => {
            this.createMainWindow();
            this.setupIpcHandlers();
            await this.handleAutoConnect();
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
                // Gracefully handle failing to create window
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
        ipcMain.handle(IPC_CHANNELS.AUTH.START, async (event, authUrl: string) => {
            return this.handleOAuth(authUrl);
        });

        ipcMain.handle(IPC_CHANNELS.PROXY.SET, async (event, config: { host: string; port: number }) => {
            return this.setSystemProxy(config);
        });

        ipcMain.handle(IPC_CHANNELS.PROXY.CLEAR, async () => {
            return this.clearSystemProxy();
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

            this.authWindow?.webContents.on('will-redirect', (event, url) => handleRedirect(url));
            this.authWindow?.webContents.on('will-navigate', (event, url) => handleRedirect(url));

            this.authWindow?.on('closed', () => {
                this.authWindow = null;
                resolve(null);
            });
        });
    }

    private async setSystemProxy(config: { host: string; port: number }) {
        try {
            await session.defaultSession.setProxy({
                proxyRules: `http=${config.host}:${config.port};https=${config.host}:${config.port}`
            });
            saveProxyConfig({ ...config, protocol: 'http', enabled: true });
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
            // Check and refresh auth if needed
            const authData = getAuthData();
            if (!authData) return;

            if (await refreshAuthToken()) {
                const servers = await ProtonVPNAPI.getServers();
                const server = servers.find(s => s.id === settings.autoConnect.serverId);
                
                if (server && server.status === 'online') {
                    await this.setSystemProxy({
                        host: server.host,
                        port: server.port
                    });
                }
            }
        } catch (error) {
            console.error('Auto-connect failed:', error);
        }
    }
}

// Start the application
new MainProcess();