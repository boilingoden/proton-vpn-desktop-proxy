// Use contextBridge to access electron APIs safely
declare global {
    interface Window {
        electron: {
            ipcRenderer: {
                invoke(channel: string, ...args: any[]): Promise<any>;
                on(channel: string, func: (...args: any[]) => void): void;
                once(channel: string, func: (...args: any[]) => void): void;
                removeAllListeners(channel: string): void;
            };
        };
    }
}

import { VPNServer, Settings, AuthConfig, ProxyConfig, ProxyError, ProxyErrorType, ErrorCode } from '../common/types';
import { 
    getAuthData, 
    saveAuthData, 
    isTokenExpired, 
    getProxyConfig, 
    getSettings, 
    updateSettings,
    getValidCredentials,
    isCredentialRefreshNeeded,
    cacheCredentials,
    refreshAuthToken,
    clearCredentials,
    clearAuthData
} from '../common/utils';
import { ProtonVPNAPI } from '../common/api';

// Use constant values for IPC channels to avoid type issues
const IPC = {
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

class NotificationManager {
    private container: HTMLDivElement;
    private notifications: Map<string, HTMLElement> = new Map();

    constructor() {
        this.container = document.querySelector('.notifications-container') as HTMLDivElement;
    }

    show(type: 'success' | 'error', title: string, message: string) {
        const id = Date.now().toString();
        const notification = document.createElement('div');
        notification.className = `notification ${type}`;
        notification.innerHTML = `
            <span class="notification-icon material-icons">
                ${type === 'success' ? 'check_circle' : 'error'}
            </span>
            <div class="notification-content">
                <h4 class="notification-title">${title}</h4>
                <p class="notification-message">${message}</p>
            </div>
            <button class="notification-close">
                <span class="material-icons">close</span>
            </button>
        `;

        const closeButton = notification.querySelector('.notification-close');
        closeButton?.addEventListener('click', () => this.hide(id));

        this.container.appendChild(notification);
        this.notifications.set(id, notification);

        setTimeout(() => this.hide(id), 5000);
        return id;
    }

    hide(id: string) {
        const notification = this.notifications.get(id);
        if (notification) {
            notification.remove();
            this.notifications.delete(id);
        }
    }
}

class SettingsManager {
    private settingsPanel: HTMLElement;
    private settingsBtn: HTMLElement;
    private closeSettingsBtn: HTMLElement;
    private settingsInputs: {
        autoConnect: HTMLInputElement;
        killSwitch: HTMLInputElement;
        protocol: HTMLSelectElement;
        customDns: HTMLInputElement;
        dnsServers: HTMLInputElement;
        splitTunnel: HTMLInputElement;
        splitTunnelMode: HTMLSelectElement;
    };

    constructor() {
        this.settingsPanel = document.getElementById('settings-panel') as HTMLElement;
        this.settingsBtn = document.getElementById('settings-btn') as HTMLElement;
        this.closeSettingsBtn = document.getElementById('close-settings') as HTMLElement;
        
        // Cast each input element to its specific type
        this.settingsInputs = {
            autoConnect: document.getElementById('setting-auto-connect') as HTMLInputElement,
            killSwitch: document.getElementById('setting-kill-switch') as HTMLInputElement,
            protocol: document.getElementById('setting-protocol') as HTMLSelectElement,
            customDns: document.getElementById('setting-custom-dns') as HTMLInputElement,
            dnsServers: document.getElementById('dns-servers') as HTMLInputElement,
            splitTunnel: document.getElementById('setting-split-tunnel') as HTMLInputElement,
            splitTunnelMode: document.getElementById('split-tunnel-mode') as HTMLSelectElement,
        };

        this.setupEventListeners();
        this.loadSettings();
    }

    private setupEventListeners() {
        this.settingsBtn.addEventListener('click', () => this.openSettings());
        this.closeSettingsBtn.addEventListener('click', () => this.closeSettings());

        // Handle conditional displays
        this.settingsInputs.customDns.addEventListener('change', () => {
            const dnsServersDiv = document.getElementById('custom-dns-servers');
            if (dnsServersDiv) {
                dnsServersDiv.style.display = this.settingsInputs.customDns.checked ? 'block' : 'none';
            }
        });

        this.settingsInputs.splitTunnel.addEventListener('change', () => {
            const splitTunnelConfig = document.getElementById('split-tunnel-config');
            if (splitTunnelConfig) {
                splitTunnelConfig.style.display = this.settingsInputs.splitTunnel.checked ? 'block' : 'none';
            }
        });

        // Save settings on change
        Object.values(this.settingsInputs).forEach(input => {
            input.addEventListener('change', () => this.saveSettings());
        });
    }

    private openSettings() {
        this.settingsPanel.classList.add('open');
    }

    private closeSettings() {
        this.settingsPanel.classList.remove('open');
    }

    public saveSettings(settings: Partial<Settings> = {}) {
        const currentSettings = getSettings();
        const updatedSettings = {
            ...currentSettings,
            ...settings
        };
        updateSettings(updatedSettings);
        this.loadSettings();
    }

    private loadSettings() {
        const settings = getSettings();
        
        this.settingsInputs.autoConnect.checked = settings.autoConnect.enabled;
        this.settingsInputs.killSwitch.checked = settings.killSwitch;
        this.settingsInputs.protocol.value = settings.protocol;
        this.settingsInputs.customDns.checked = settings.dns.custom;
        this.settingsInputs.dnsServers.value = settings.dns.servers.join(', ');
        this.settingsInputs.splitTunnel.checked = settings.splitTunneling.enabled;
        this.settingsInputs.splitTunnelMode.value = settings.splitTunneling.mode;

        // Update conditional displays
        const dnsServersDiv = document.getElementById('custom-dns-servers');
        if (dnsServersDiv) {
            dnsServersDiv.style.display = settings.dns.custom ? 'block' : 'none';
        }

        const splitTunnelConfig = document.getElementById('split-tunnel-config');
        if (splitTunnelConfig) {
            splitTunnelConfig.style.display = settings.splitTunneling.enabled ? 'block' : 'none';
        }
    }
}

enum ConnectionState {
    DISCONNECTED,
    CONNECTING,
    CONNECTED,
    ERROR
}

class VPNClientUI {
    private signInView: HTMLElement;
    private mainView: HTMLElement;
    private signInButton: HTMLButtonElement;
    private signUpButton: HTMLButtonElement;
    private signInLink: HTMLElement;
    private incentiveParagraph: HTMLElement;
    
    private connectButton: HTMLButtonElement;
    private disconnectButton: HTMLButtonElement;
    private statusElement: HTMLDivElement;
    private statusText: HTMLSpanElement;
    private serverList: HTMLDivElement;
    private filterButtons: NodeListOf<HTMLButtonElement>;
    private settingsManager: SettingsManager;
    private isConnected: boolean = false;
    private currentServer: VPNServer | null = null;
    private currentFilter: string = 'all';
    private notifications: NotificationManager;
    private servers: VPNServer[] = [];
    private searchInput: HTMLInputElement;
    private credentialRefreshTimer: NodeJS.Timeout | null = null;
    private retryTimeout: NodeJS.Timeout | null = null;
    private readonly MAX_RETRY_ATTEMPTS = 4;
    private retryAttempts = 0;
    private lastRetryTime = 0;
    private connectionState: ConnectionState = ConnectionState.DISCONNECTED;
    private maxCredentialFailures: number = 10;
    private credentialFailures: number = 0;
    private connectionTimeout: NodeJS.Timeout | null = null;
    private static readonly CONNECTION_TIMEOUT = 30000; // 30 seconds
    private static readonly CREDENTIAL_RETRY_DELAY = 400; // 400ms

    constructor() {
        // Initialize sign-in related elements
        this.signInView = document.getElementById('sign-in-view') as HTMLElement;
        this.mainView = document.getElementById('main-view') as HTMLElement;
        this.signInButton = this.signInView.querySelector('.sign-in-button') as HTMLButtonElement;
        this.signUpButton = this.signInView.querySelector('.sign-up-button') as HTMLButtonElement;
        this.signInLink = this.signInView.querySelector('.sign-in-link') as HTMLElement;
        this.incentiveParagraph = this.signInView.querySelector('.incentive-paragraph') as HTMLElement;

        // Initialize existing elements
        this.connectButton = document.getElementById('connect-btn') as HTMLButtonElement;
        this.disconnectButton = document.getElementById('disconnect-btn') as HTMLButtonElement;
        this.statusElement = document.getElementById('connection-status') as HTMLDivElement;
        this.statusText = this.statusElement.querySelector('.status-text') as HTMLSpanElement;
        this.serverList = document.getElementById('server-list') as HTMLDivElement;
        this.filterButtons = document.querySelectorAll('.filter-button');

        this.notifications = new NotificationManager();
        this.searchInput = document.getElementById('server-search') as HTMLInputElement;
        this.settingsManager = new SettingsManager();

        this.setupSignInView();
        this.initializeUI();
        this.setupEventListeners();
        this.restoreState();
        this.setupProxyEventListeners();
    }

    private setupSignInView() {
        // Set incentive text
        this.incentiveParagraph.textContent = "Protect yourself online with Proton's free high-speed VPN";

        // Setup sign in button
        this.signInButton.addEventListener('click', async () => {
            const authResult = await this.handleAuth();
            if (authResult) {
                this.showMainView();
            }
        });

        // Setup sign up button
        this.signUpButton.addEventListener('click', async () => {
            const signupUrl = 'https://account.protonvpn.com/signup';
            window.open(signupUrl, '_blank');
        });

        // Setup sign in link (alternative sign in method)
        this.signInLink.addEventListener('click', async (e) => {
            e.preventDefault();
            const authResult = await this.handleAuth();
            if (authResult) {
                this.showMainView();
            }
        });

        // Check auth status on load
        this.checkInitialAuth();
    }

    private async checkInitialAuth() {
        const authData = getAuthData();
        if (authData && !isTokenExpired(authData.expiresAt)) {
            this.showMainView();
        } else {
            this.showSignInView();
        }
    }

    private showMainView() {
        this.signInView.style.display = 'none';
        this.mainView.style.display = 'block';
    }

    private showSignInView() {
        this.signInView.style.display = 'block';
        this.mainView.style.display = 'none';
    }

    private setupProxyEventListeners() {
        // Listen for proxy connection lost events from main process
        window.electron.ipcRenderer.on(IPC.EVENTS.PROXY_CONNECTION_LOST, async (error?: ProxyError) => {
            if (!this.isConnected) return; // Avoid duplicate handling

            if (error) {
                // Handle specific error types like the extension
                switch (error.type) {
                    case ProxyErrorType.AUTH_FAILED:
                        await this.handleAuthFailure();
                        break;
                    case ProxyErrorType.NETWORK_ERROR:
                        await this.handleNetworkError(error);
                        break;
                    case ProxyErrorType.SERVER_ERROR:
                        if (error.retryable) {
                            await this.retryConnection(0);
                        } else {
                            await this.handleFatalError(error);
                        }
                        break;
                    case ProxyErrorType.LOGICAL_ERROR:
                        await this.handleLogicalError();
                        break;
                    default:
                        await this.handleProxyError(new Error(error.message));
                }
            } else {
                // Generic connection lost handling
                this.isConnected = false;
                this.updateUI(false);
                this.showError('Connection lost: Proxy server unreachable');
                
                if (this.currentServer) {
                    await this.retryConnection(0);
                }
            }
        });

        // Handle credential expiration
        window.electron.ipcRenderer.on(IPC.EVENTS.CREDENTIALS_EXPIRED, async () => {
            if (!this.isConnected) return;

            try {
                const credentials = await this.getProxyCredentials();
                if (credentials && this.currentServer) {
                    const success = await window.electron.ipcRenderer.invoke(IPC.PROXY.SET, {
                        host: this.currentServer.host,
                        port: this.currentServer.port,
                        username: credentials.username,
                        password: credentials.password
                    });

                    if (success) {
                        this.scheduleCredentialRefresh(credentials.expiresIn);
                        this.showSuccess('Credentials refreshed successfully');
                    } else {
                        throw new Error('Failed to update credentials');
                    }
                } else {
                    throw new Error('Failed to get new credentials');
                }
            } catch (error) {
                console.error('Credential refresh failed:', error);
                await this.disconnect();
                this.showError('Connection lost: Failed to refresh credentials');
            }
        });
    }

    private async getProxyCredentials(retryCount = 0): Promise<{ username: string; password: string; expiresIn: number } | null> {
        try {
            // Check cached credentials first
            const cached = getValidCredentials();
            if (cached && !isCredentialRefreshNeeded()) {
                return {
                    username: cached.credentials.Username,
                    password: cached.credentials.Password,
                    expiresIn: cached.credentials.Expire
                };
            }

            // Get fresh credentials
            const credentials = await ProtonVPNAPI.getProxyToken(3600);
            if (!credentials) {
                throw new Error('Failed to get proxy credentials');
            }

            // Cache the new credentials
            cacheCredentials(credentials);
            return credentials;
        } catch (error: unknown) {
            console.error('Credential fetch error:', error);
            
            const errorMessage = error instanceof Error ? error.message : String(error);
            
            // Handle auth errors
            if (errorMessage.includes('401') || errorMessage.includes('unauthorized')) {
                if (retryCount < 3) {
                    const success = await refreshAuthToken();
                    if (success) {
                        return this.getProxyCredentials(retryCount + 1);
                    }
                }
                await this.handleAuthFailure();
                return null;
            }

            // Handle rate limiting
            if (errorMessage.includes('429') && retryCount < 3) {
                await new Promise(resolve => setTimeout(resolve, Math.pow(2, retryCount) * 1000));
                return this.getProxyCredentials(retryCount + 1);
            }

            return null;
        }
    }

    private async handleAuthFailure() {
        try {
            const success = await refreshAuthToken();
            if (success) {
                const credentials = await this.getProxyCredentials();
                if (credentials && this.currentServer) {
                    await this.retryConnection(0);
                    return;
                }
            }
            
            await this.disconnect();
            this.showError('Authentication failed. Please sign in again.');
            this.showSignInView();
            
            // Clear credentials and auth data
            clearCredentials();
            clearAuthData();
        } catch (error) {
            console.error('Auth failure handling failed:', error);
            await this.disconnect();
            this.showError('Authentication error occurred');
        }
    }

    private async handleNetworkError(error: ProxyError) {
        this.showError(`Network error: ${error.message}`);
        if (error.retryable) {
            // Wait for network to stabilize before retry
            setTimeout(async () => {
                if (this.currentServer) {
                    await this.retryConnection(0);
                }
            }, 2000);
        } else {
            await this.disconnect();
        }
    }

    private async handleFatalError(error: ProxyError) {
        await this.disconnect();
        this.showError(`Connection error: ${error.message}`);
    }

    private async handleLogicalError() {
        // Try to find an alternative server like the extension does
        try {
            const servers = await ProtonVPNAPI.getServers();
            const alternativeServer = servers.find(s => 
                s.status === 'online' && 
                s.id !== this.currentServer?.id &&
                s.features?.every(f => this.currentServer?.features?.includes(f))
            );

            if (alternativeServer) {
                this.currentServer = alternativeServer;
                await this.connect();
                this.showSuccess('Switched to alternative server');
            } else {
                await this.disconnect();
                this.showError('No alternative servers available');
            }
        } catch (error) {
            console.error('Failed to handle logical error:', error);
            await this.disconnect();
            this.showError('Failed to find alternative server');
        }
    }

    // Update the retryConnection method to handle more error cases
    private async retryConnection(retryCount: number) {
        if (!this.currentServer || !this.connectionState) return;

        try {
            const delay = this.getRetryDelay(retryCount);
            this.retryTimeout = setTimeout(async () => {
                try {
                    // Check cached credentials first
                    let validCreds = getValidCredentials()?.credentials;
                    if (!validCreds || isCredentialRefreshNeeded()) {
                        const newCreds = await this.getProxyCredentials();
                        if (!newCreds) {
                            throw new Error('Failed to get credentials');
                        }
                        cacheCredentials(newCreds);
                        validCreds = {
                            Username: newCreds.username,
                            Password: newCreds.password,
                            Expire: newCreds.expiresIn
                        };
                    }

                    const success = await window.electron.ipcRenderer.invoke(IPC.PROXY.SET, {
                        host: this.currentServer!.host,
                        port: this.currentServer!.port,
                        username: validCreds.Username,
                        password: validCreds.Password
                    });

                    if (success) {
                        this.retryAttempts = 0;
                        this.showSuccess('Connection restored');
                        this.scheduleCredentialRefresh(validCreds.Expire);
                    } else {
                        throw new Error('Failed to set proxy configuration');
                    }
                } catch (error) {
                    console.error('Retry attempt failed:', error);
                    if (retryCount >= this.MAX_RETRY_ATTEMPTS) {
                        await this.handleFatalError({
                            type: ProxyErrorType.SERVER_ERROR,
                            message: 'Maximum retry attempts reached',
                            retryable: false
                        });
                    } else {
                        await this.retryConnection(retryCount + 1);
                    }
                }
            }, delay);
        } catch (error) {
            console.error('Error in retry sequence:', error);
            await this.disconnect();
            this.showError('Failed to reconnect to proxy');
        }
    }

    private async initializeUI() {
        await this.loadServers();
        await this.checkAuthStatus();
    }

    private async loadServers() {
        try {
            this.setAppLoading(true);
            this.servers = await ProtonVPNAPI.getServers();
            this.filterAndRenderServers();
        } catch (error) {
            this.showError('Failed to load servers');
            console.error('Failed to load servers:', error);
        } finally {
            this.setAppLoading(false);
        }
    }

    private filterAndRenderServers() {
        const searchTerm = this.searchInput.value.toLowerCase();
        const filteredServers = this.servers.filter(server => {
            const matchesFilter = this.currentFilter === 'all' || server.features?.includes(this.currentFilter);
            const matchesSearch = searchTerm === '' || 
                server.name.toLowerCase().includes(searchTerm) ||
                (server.country?.toLowerCase().includes(searchTerm) ?? false) ||
                server.features?.some(f => f.toLowerCase().includes(searchTerm)) ||
                server.city?.toLowerCase().includes(searchTerm);

            return matchesFilter && matchesSearch;
        });

        this.renderServerList(filteredServers);
    }

    private renderServerList(servers: VPNServer[]) {
        this.serverList.innerHTML = '';
        
        if (servers.length === 0) {
            this.serverList.innerHTML = `
                <div class="no-results">
                    <span class="material-icons">search_off</span>
                    <p>No servers found matching your criteria</p>
                </div>
            `;
            return;
        }

        servers.forEach(server => {
            const serverElement = document.createElement('div');
            serverElement.className = 'server-item';
            if (server.status !== 'online') {
                serverElement.classList.add('offline');
            }
            
            serverElement.innerHTML = `
                <div class="server-icon">
                    <span class="material-icons">${this.getServerIcon(server)}</span>
                </div>
                <div class="server-info">
                    <h3>${server.name}</h3>
                    <p>${server.city ? `${server.city}, ` : ''}${server.country}</p>
                </div>
                <div class="server-stats">
                    <div class="server-load">
                        <span class="material-icons">speed</span>
                        Load: ${server.load ?? 0}%
                    </div>
                    ${server.features?.length ? `
                        <div class="server-features">
                            ${server.features.map(f => `<span class="feature-tag">${f}</span>`).join('')}
                        </div>
                    ` : ''}
                    ${server.status !== 'online' ? `
                        <div class="server-status">${server.status}</div>
                    ` : ''}
                </div>
            `;
            
            if (server.status === 'online') {
                serverElement.addEventListener('click', () => this.selectServer(server));
            }
            
            this.serverList.appendChild(serverElement);
        });
    }

    private getServerIcon(server: VPNServer): string {
        if (server.status !== 'online') return 'error_outline';
        if (server.features?.includes('secure-core')) return 'security';
        if (server.features?.includes('tor')) return 'vpn_lock';
        if (server.features?.includes('p2p')) return 'swap_horiz';
        return 'public';
    }

    private setAppLoading(isLoading: boolean) {
        this.serverList.classList.toggle('loading', isLoading);
        this.searchInput.disabled = isLoading;
        this.filterButtons.forEach(btn => btn.disabled = isLoading);
    }

    private async checkAuthStatus() {
        const authData = getAuthData();
        if (!authData || isTokenExpired(authData.expiresAt)) {
            this.connectButton.disabled = false;
            return false;
        }
        return true;
    }

    private setupEventListeners() {
        this.connectButton.addEventListener('click', () => this.connect());
        this.disconnectButton.addEventListener('click', () => this.disconnect());
        this.searchInput.addEventListener('input', () => this.filterAndRenderServers());
        this.filterButtons.forEach(button => {
            button.addEventListener('click', () => {
                this.filterButtons.forEach(btn => btn.classList.remove('active'));
                button.classList.add('active');
                this.currentFilter = button.dataset.filter || 'all';
                this.filterAndRenderServers();
            });
        });

        // Add proxy error handling
        window.electron.ipcRenderer.on(IPC.EVENTS.PROXY_CONNECTION_LOST, async () => {
            await this.handleProxyError(new Error('Proxy connection lost'));
        });
    }

    private async restoreState() {
        const proxyConfig = getProxyConfig();
        if (proxyConfig?.enabled) {
            this.isConnected = true;
            this.updateUI(true);
        }
    }

    private async scheduleCredentialRefresh(expiresInSeconds: number): Promise<void> {
        if (this.credentialRefreshTimer) {
            clearTimeout(this.credentialRefreshTimer);
        }

        // Refresh at 90% of expiry time
        const refreshTime = (expiresInSeconds * 0.9) * 1000;
        
        this.credentialRefreshTimer = setTimeout(async () => {
            try {
                if (!this.isConnected || !this.currentServer) return;

                const credentials = await this.getProxyCredentials();
                if (!credentials) {
                    throw new Error('Failed to refresh credentials');
                }

                // Update proxy with new credentials
                const success = await window.electron.ipcRenderer.invoke(IPC.PROXY.SET, {
                    host: this.currentServer.host,
                    port: this.currentServer.port,
                    username: credentials.username,
                    password: credentials.password,
                    bypassList: this.currentServer.bypassList
                });

                if (success) {
                    this.showSuccess('Credentials refreshed successfully');
                    this.scheduleCredentialRefresh(credentials.expiresIn);
                } else {
                    throw new Error('Failed to update proxy configuration');
                }
            } catch (error) {
                console.error('Credential refresh failed:', error);
                
                if (error instanceof Error && 
                    (error.message.includes('401') || error.message.includes('unauthorized'))) {
                    await this.handleAuthFailure();
                } else {
                    await this.handleProxyError(error instanceof Error ? error : new Error('Credential refresh failed'));
                }
            }
        }, refreshTime);
    }

    private getRetryDelay(attempt: number): number {
        // Exponential backoff: 500ms, 2s, 6s, 12s (matching extension)
        if (attempt === 0) return 500;
        return Math.min(Math.pow(2, attempt - 1) * 2000, 12000);
    }

    private async handleProxyError(error: Error | ProxyError): Promise<void> {
        console.error('Proxy error:', error);
        
        // Clear existing timers
        this.clearTimers();

        // Check if we exceeded credential failures
        if (this.credentialFailures >= this.maxCredentialFailures) {
            await this.disconnect();
            this.showError('Authentication failed: Too many consecutive failures');
            return;
        }

        // Check proxy status
        const proxyStatus = await window.electron.ipcRenderer.invoke(IPC.PROXY.STATUS);
        if (!proxyStatus) {
            this.isConnected = false;
            this.updateUI(false);
            this.showError('Connection lost: Proxy server unreachable');
            return;
        }

        const errorMessage = error instanceof Error ? error.message : error.message;
        if (errorMessage.toLowerCase().includes('401') || errorMessage.toLowerCase().includes('unauthorized')) {
            this.credentialFailures++;
            const authData = getAuthData();
            if (authData) {
                const success = await refreshAuthToken();
                if (success) {
                    await this.retryConnection(0); // Reset retry count for auth failures
                    return;
                }
            }
            await this.disconnect();
            this.showError('Authentication failed. Please sign in again.');
            return;
        }

        // Network or timeout errors
        if (errorMessage.includes(ErrorCode.NETWORK_CHANGED) || 
            errorMessage.includes(ErrorCode.NETWORK_IO_SUSPENDED)) {
            await this.retryConnection(0); // Immediate retry for network changes
            return;
        }

        if (errorMessage.includes(ErrorCode.TUNNEL_CONNECTION_FAILED) ||
            errorMessage.includes(ErrorCode.PROXY_CONNECTION_FAILED) ||
            errorMessage.includes(ErrorCode.TIMED_OUT) ||
            errorMessage.includes('ECONNREFUSED') || 
            errorMessage.includes('ETIMEDOUT')) {
            
            // Prevent too frequent retries
            const now = Date.now();
            if (now - this.lastRetryTime < 5000) {
                return;
            }
            this.lastRetryTime = now;

            if (this.retryAttempts >= this.MAX_RETRY_ATTEMPTS) {
                await this.disconnect();
                this.showError('Connection lost after multiple retry attempts');
                this.retryAttempts = 0;
                return;
            }

            this.showError(`Connection issue: Attempting to reconnect... (Attempt ${this.retryAttempts + 1}/${this.MAX_RETRY_ATTEMPTS})`);
            await this.retryConnection(this.retryAttempts++);
        }
    }

    private clearTimers() {
        if (this.retryTimeout) {
            clearTimeout(this.retryTimeout);
            this.retryTimeout = null;
        }
        if (this.credentialRefreshTimer) {
            clearTimeout(this.credentialRefreshTimer);
            this.credentialRefreshTimer = null;
        }
        if (this.connectionTimeout) {
            clearTimeout(this.connectionTimeout);
            this.connectionTimeout = null;
        }
    }

    private async connect() {
        if (!this.currentServer) {
            this.showError('Please select a server first');
            return;
        }

        this.setLoading(true, this.connectButton);
        this.connectionState = ConnectionState.CONNECTING;

        try {
            if (!await this.checkAuthStatus()) {
                const authResult = await this.handleAuth();
                if (!authResult) {
                    this.setLoading(false, this.connectButton);
                    return;
                }
            }

            // Start connection timeout
            this.connectionTimeout = setTimeout(() => {
                if (this.connectionState === ConnectionState.CONNECTING) {
                    this.handleProxyError(new Error('Connection initialization timeout'));
                }
            }, VPNClientUI.CONNECTION_TIMEOUT);

            // Reset credential failures on new connection
            this.credentialFailures = 0;

            // Get proxy credentials
            const credentials = await this.getProxyCredentials();
            if (!credentials) {
                throw new Error('Failed to get proxy credentials');
            }

            // Update auto-connect settings if enabled
            const settings = getSettings();
            if (settings.autoConnect.enabled) {
                settings.autoConnect.serverId = this.currentServer.id;
                this.settingsManager.saveSettings(settings);
            }

            const success = await window.electron.ipcRenderer.invoke(IPC.PROXY.SET, {
                host: this.currentServer.host,
                port: this.currentServer.port,
                username: credentials.username,
                password: credentials.password,
                bypassList: [
                    'localhost',
                    '127.0.0.1',
                    '127.0.0.0/8',
                    '10.0.0.0/8',
                    '172.16.0.0/12',
                    '192.168.0.0/16',
                    '[::1]',
                    '<local>',
                    ...(this.currentServer.bypassList || [])
                ]
            });

            if (success) {
                this.clearTimers();
                this.connectionState = ConnectionState.CONNECTED;
                this.isConnected = true;
                this.updateUI(true);
                this.showSuccess('Successfully connected to proxy');
                this.scheduleCredentialRefresh(credentials.expiresIn);
            } else {
                throw new Error('Failed to set proxy configuration');
            }
        } catch (error) {
            console.error('Connection error:', error);
            this.connectionState = ConnectionState.ERROR;
            await this.handleProxyError(error instanceof Error ? error : new Error('Failed to connect to proxy'));
        } finally {
            this.setLoading(false, this.connectButton);
        }
    }

    private async disconnect() {
        this.setLoading(true, this.disconnectButton);
        try {
            this.clearTimers();
            this.connectionState = ConnectionState.DISCONNECTED;
            
            const success = await window.electron.ipcRenderer.invoke(IPC.PROXY.CLEAR);
            if (success) {
                this.isConnected = false;
                this.updateUI(false);
                this.showSuccess('Successfully disconnected from proxy');
            } else {
                this.showError('Failed to disconnect from proxy');
            }
        } catch (error) {
            console.error('Disconnection error:', error);
            this.showError('Failed to disconnect from proxy');
        } finally {
            this.setLoading(false, this.disconnectButton);
        }
    }

    private updateUI(isConnected: boolean) {
        const status = isConnected ? 'Connected' : 'Disconnected';
        const serverInfo = this.currentServer ? ` - ${this.currentServer.name}` : '';
        this.statusText.textContent = status + serverInfo;
        this.statusElement.classList.toggle('status-connected', isConnected);
        this.connectButton.style.display = isConnected ? 'none' : 'block';
        this.disconnectButton.style.display = isConnected ? 'block' : 'none';
        
        // Update server list items state
        const serverElements = this.serverList.getElementsByClassName('server-item');
        Array.from(serverElements).forEach(el => {
            el.classList.toggle('disabled', isConnected && !el.classList.contains('selected'));
        });
    }

    private setLoading(isLoading: boolean, button: HTMLButtonElement) {
        button.disabled = isLoading;
        if (isLoading) {
            const overlay = document.createElement('div');
            overlay.className = 'loading-overlay';
            overlay.innerHTML = '<div class="loading-spinner"></div>';
            button.appendChild(overlay);
        } else {
            const overlay = button.querySelector('.loading-overlay');
            overlay?.remove();
        }
    }

    private async handleAuth(): Promise<boolean> {
        const authUrl = 'https://account.protonvpn.com/authorize';
        try {
            this.signInButton.classList.add('loading');
            const result = await window.electron.ipcRenderer.invoke(IPC.AUTH.START, authUrl);
            if (result) {
                const urlParams = new URLSearchParams(result.split('?')[1]);
                const accessToken = urlParams.get('access_token');
                const refreshToken = urlParams.get('refresh_token');
                const expiresIn = urlParams.get('expires_in');
                
                if (accessToken && refreshToken && expiresIn) {
                    saveAuthData({
                        accessToken,
                        refreshToken,
                        expiresAt: Date.now() + (Number(expiresIn) * 1000)
                    });
                    return true;
                }
            }
        } catch (error) {
            console.error('Authentication failed:', error);
            this.showError('Authentication failed');
        } finally {
            this.signInButton.classList.remove('loading');
        }
        return false;
    }

    private showError(message: string) {
        this.notifications.show('error', 'Error', message);
    }

    private showSuccess(message: string) {
        this.notifications.show('success', 'Success', message);
    }

    private selectServer(server: VPNServer, event?: Event) {
        this.currentServer = server;
        const serverElements = this.serverList.getElementsByClassName('server-item');
        Array.from(serverElements).forEach(el => el.classList.remove('selected'));
        
        // Find the clicked server element using the event target if available
        const targetElement = event?.target instanceof HTMLElement 
            ? event.target.closest('.server-item')
            : Array.from(serverElements).find(el => 
                el.querySelector('.server-info')?.textContent?.includes(server.name)
            );
            
        targetElement?.classList.add('selected');
    }
}

// Initialize the VPN client UI when the DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new VPNClientUI();
});