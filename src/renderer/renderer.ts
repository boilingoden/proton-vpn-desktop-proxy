import { ipcRenderer } from 'electron';
import { VPNServer, VPNConnectionConfig, IPC_CHANNELS } from '../common/types';
import { getAuthData, saveAuthData, isTokenExpired, getProxyConfig } from '../common/utils';
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

class VPNClientUI {
    private connectButton: HTMLButtonElement;
    private disconnectButton: HTMLButtonElement;
    private statusElement: HTMLDivElement;
    private statusText: HTMLSpanElement;
    private serverList: HTMLDivElement;
    private filterButtons: NodeListOf<HTMLButtonElement>;
    private isConnected: boolean = false;
    private isLoading: boolean = false;
    private currentServer: VPNServer | null = null;
    private currentFilter: string = 'all';
    private notifications: NotificationManager;
    private servers: VPNServer[] = [];
    private searchInput: HTMLInputElement;

    constructor() {
        this.connectButton = document.getElementById('connect-btn') as HTMLButtonElement;
        this.disconnectButton = document.getElementById('disconnect-btn') as HTMLButtonElement;
        this.statusElement = document.getElementById('connection-status') as HTMLDivElement;
        this.statusText = this.statusElement.querySelector('.status-text') as HTMLSpanElement;
        this.serverList = document.getElementById('server-list') as HTMLDivElement;
        this.filterButtons = document.querySelectorAll('.filter-button');

        this.notifications = new NotificationManager();
        this.searchInput = document.getElementById('server-search') as HTMLInputElement;

        this.initializeUI();
        this.setupEventListeners();
        this.restoreState();
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
                server.country.toLowerCase().includes(searchTerm) ||
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
    }

    private async restoreState() {
        const proxyConfig = getProxyConfig();
        if (proxyConfig?.enabled) {
            this.isConnected = true;
            this.updateUI(true);
        }
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

            const success = await ipcRenderer.invoke(IPC_CHANNELS.PROXY.SET, {
                host: this.currentServer.host,
                port: this.currentServer.port
            });

            if (success) {
                this.isConnected = true;
                this.updateUI(true);
                this.showSuccess('Successfully connected to VPN');
            } else {
                this.showError('Failed to connect to VPN');
            }
        } catch (error) {
            console.error('Connection error:', error);
            this.showError('Failed to connect to VPN');
        } finally {
            this.setLoading(false, this.connectButton);
        }
    }

    private async disconnect() {
        this.setLoading(true, this.disconnectButton);
        try {
            const success = await ipcRenderer.invoke(IPC_CHANNELS.PROXY.CLEAR);
            if (success) {
                this.isConnected = false;
                this.updateUI(false);
                this.showSuccess('Successfully disconnected from VPN');
            } else {
                this.showError('Failed to disconnect from VPN');
            }
        } catch (error) {
            console.error('Disconnection error:', error);
            this.showError('Failed to disconnect from VPN');
        } finally {
            this.setLoading(false, this.disconnectButton);
        }
    }

    private async handleAuth() {
        const authUrl = 'https://account.protonvpn.com/authorize'; // Replace with actual OAuth URL
        try {
            const result = await ipcRenderer.invoke(IPC_CHANNELS.AUTH.START, authUrl);
            if (result) {
                const urlParams = new URLSearchParams(result.split('?')[1]);
                const token = urlParams.get('token');
                if (token) {
                    saveAuthData({
                        accessToken: token,
                        refreshToken: '', // In real implementation, get from OAuth response
                        expiresAt: Date.now() + 3600000 // 1 hour expiry
                    });
                    return true;
                }
            }
        } catch (error) {
            console.error('Authentication failed:', error);
            alert('Authentication failed');
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