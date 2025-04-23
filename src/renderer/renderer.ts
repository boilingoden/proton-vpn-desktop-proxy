import { ipcRenderer } from 'electron';
import { VPNServer, IPC_CHANNELS, Settings } from '../common/types';
import { getAuthData, saveAuthData, isTokenExpired, getProxyConfig, getSettings, updateSettings } from '../common/utils';
import { ProtonVPNAPI } from '../common/api';

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
    private isConnected: boolean = false;
    private currentServer: VPNServer | null = null;
    private currentFilter: string = 'all';
    private notifications: NotificationManager;
    private servers: VPNServer[] = [];
    private searchInput: HTMLInputElement;
    private credentialRefreshTimer: NodeJS.Timeout | null = null;
    private readonly RETRY_DELAYS = [1000, 2000, 4000]; // Exponential backoff delays
    private retryTimeout: NodeJS.Timeout | null = null;
    private settingsManager: SettingsManager;

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
        ipcRenderer.on(IPC_CHANNELS.EVENTS.PROXY_CONNECTION_LOST, async () => {
            this.isConnected = false;
            this.updateUI(false);
            this.showError('Connection lost: Proxy server unreachable');
            
            // Try to reconnect if we have a current server
            if (this.currentServer) {
                await this.retryConnection();
            }
        });
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
        ipcRenderer.on(IPC_CHANNELS.EVENTS.PROXY_CONNECTION_LOST, async () => {
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

    private async scheduleCredentialRefresh(expiresInSeconds: number) {
        if (this.credentialRefreshTimer) {
            clearTimeout(this.credentialRefreshTimer);
        }

        // Refresh credentials at 90% of expiry time
        const refreshTime = (expiresInSeconds * 0.9) * 1000;
        
        this.credentialRefreshTimer = setTimeout(async () => {
            try {
                const credentials = await this.getProxyCredentials();
                if (credentials && this.isConnected && this.currentServer) {
                    // Update proxy with new credentials
                    await ipcRenderer.invoke(IPC_CHANNELS.PROXY.SET, {
                        host: this.currentServer.host,
                        port: this.currentServer.port,
                        username: credentials.username,
                        password: credentials.password
                    });
                }
            } catch (error) {
                console.error('Failed to refresh credentials:', error);
                // If credentials refresh fails, disconnect
                await this.disconnect();
                this.showError('Connection lost: Failed to refresh credentials');
            }
        }, refreshTime);
    }

    private async getProxyCredentials(): Promise<{ username: string; password: string; expiresIn: number } | null> {
        try {
            const authData = getAuthData();
            if (!authData?.accessToken) return null;

            const response = await fetch('https://api.protonvpn.com/v2/vpn/browser/token?Duration=3600', {
                headers: {
                    'Authorization': `Bearer ${authData.accessToken}`
                }
            });

            if (!response.ok) {
                throw new Error('Failed to get proxy credentials');
            }

            const data = await response.json();
            if (data.Code !== 1000 || !data.Username || !data.Password || !data.Expire) {
                throw new Error('Invalid proxy credentials response');
            }

            return {
                username: data.Username,
                password: data.Password,
                expiresIn: data.Expire
            };
        } catch (error) {
            console.error('Failed to get proxy credentials:', error);
            return null;
        }
    }

    private async retryConnection(retryCount: number = 0) {
        if (!this.currentServer || !this.isConnected) return;

        try {
            if (retryCount >= this.RETRY_DELAYS.length) {
                // If we've exhausted retries, disconnect
                await this.disconnect();
                this.showError('Connection lost after multiple retry attempts');
                return;
            }

            const delay = this.RETRY_DELAYS[retryCount];
            this.retryTimeout = setTimeout(async () => {
                try {
                    const credentials = await this.getProxyCredentials();
                    if (!credentials) {
                        throw new Error('Failed to get credentials');
                    }

                    const success = await ipcRenderer.invoke(IPC_CHANNELS.PROXY.SET, {
                        host: this.currentServer!.host,
                        port: this.currentServer!.port,
                        username: credentials.username,
                        password: credentials.password
                    });

                    if (success) {
                        // Connection restored
                        this.showSuccess('Connection restored');
                        this.scheduleCredentialRefresh(credentials.expiresIn);
                    } else {
                        // Try again with increased retry count
                        this.retryConnection(retryCount + 1);
                    }
                } catch (error) {
                    console.error('Retry attempt failed:', error);
                    this.retryConnection(retryCount + 1);
                }
            }, delay);
        } catch (error) {
            console.error('Error in retry sequence:', error);
            await this.disconnect();
            this.showError('Failed to reconnect to proxy');
        }
    }

    private async handleProxyError(error: Error) {
        console.error('Proxy error:', error);
        
        // Clear any existing retry timeout
        if (this.retryTimeout) {
            clearTimeout(this.retryTimeout);
            this.retryTimeout = null;
        }

        // Stop credential refresh timer
        if (this.credentialRefreshTimer) {
            clearTimeout(this.credentialRefreshTimer);
            this.credentialRefreshTimer = null;
        }

        // Check proxy status
        const proxyStatus = await ipcRenderer.invoke(IPC_CHANNELS.PROXY.STATUS);
        if (!proxyStatus) {
            // If proxy is completely down, disconnect
            this.isConnected = false;
            this.updateUI(false);
            this.showError('Connection lost: Proxy server unreachable');
            return;
        }

        // Try to refresh auth token if we get a 401
        if (error.message.includes('401') || error.message.includes('unauthorized')) {
            const authData = getAuthData();
            if (authData && !isTokenExpired(authData.expiresAt)) {
                await this.retryConnection();
                return;
            }
        }

        // Show error and initiate retry sequence
        this.showError('Connection issue: Attempting to reconnect...');
        this.retryConnection();
    }

    private async connect() {
        if (!this.currentServer) {
            this.showError('Please select a server first');
            return;
        }

        this.setLoading(true, this.connectButton);

        try {
            if (!await this.checkAuthStatus()) {
                const authResult = await this.handleAuth();
                if (!authResult) {
                    this.setLoading(false, this.connectButton);
                    return;
                }
            }

            // Get proxy credentials
            const credentials = await this.getProxyCredentials();
            if (!credentials) {
                this.showError('Failed to get proxy credentials');
                return;
            }

            // Update auto-connect settings if enabled
            const settings = getSettings();
            if (settings.autoConnect.enabled) {
                settings.autoConnect.serverId = this.currentServer.id;
                this.settingsManager.saveSettings(settings);
            }

            // Local network bypass list
            const bypassList = [
                'localhost',
                '127.0.0.1',
                '127.0.0.0/8',
                '10.0.0.0/8',
                '172.16.0.0/12',
                '192.168.0.0/16',
                '[::1]',
                '<local>'
            ];

            const success = await ipcRenderer.invoke(IPC_CHANNELS.PROXY.SET, {
                host: this.currentServer.host,
                port: this.currentServer.port,
                username: credentials.username,
                password: credentials.password,
                bypassList
            });

            if (success) {
                this.isConnected = true;
                this.updateUI(true);
                this.showSuccess('Successfully connected to proxy');
                // Schedule credential refresh
                this.scheduleCredentialRefresh(credentials.expiresIn);
            } else {
                this.showError('Failed to connect to proxy');
            }
        } catch (error) {
            console.error('Connection error:', error);
            this.showError('Failed to connect to proxy');
        } finally {
            this.setLoading(false, this.connectButton);
        }
    }

    private async disconnect() {
        this.setLoading(true, this.disconnectButton);
        try {
            // Clear retry timeout if it exists
            if (this.retryTimeout) {
                clearTimeout(this.retryTimeout);
                this.retryTimeout = null;
            }

            // Clear credential refresh timer
            if (this.credentialRefreshTimer) {
                clearTimeout(this.credentialRefreshTimer);
                this.credentialRefreshTimer = null;
            }

            const success = await ipcRenderer.invoke(IPC_CHANNELS.PROXY.CLEAR);
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

    private async handleAuth() {
        const authUrl = 'https://account.protonvpn.com/authorize';
        try {
            this.signInButton.classList.add('loading');
            const result = await ipcRenderer.invoke(IPC_CHANNELS.AUTH.START, authUrl);
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

    private selectServer(server: VPNServer) {
        this.currentServer = server;
        const serverElements = this.serverList.getElementsByClassName('server-item');
        Array.from(serverElements).forEach(el => el.classList.remove('selected'));
        (event?.target as HTMLElement)?.closest('.server-item')?.classList.add('selected');
    }

    private showError(message: string) {
        this.notifications.show('error', 'Error', message);
    }

    private showSuccess(message: string) {
        this.notifications.show('success', 'Success', message);
    }

    private updateUI(isConnected: boolean) {
        this.statusText.textContent = isConnected ? 'Connected' : 'Disconnected';
        this.statusElement.classList.toggle('status-connected', isConnected);
        this.connectButton.style.display = isConnected ? 'none' : 'block';
        this.disconnectButton.style.display = isConnected ? 'block' : 'none';
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
}

// Initialize the VPN client UI when the DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new VPNClientUI();
});