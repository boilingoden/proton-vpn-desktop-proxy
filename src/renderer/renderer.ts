import { ipcRenderer } from 'electron';
import { VPNServer, VPNConnectionConfig, IPC_CHANNELS } from '../common/types';
import { getAuthData, saveAuthData, isTokenExpired, getProxyConfig } from '../common/utils';

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

    constructor() {
        this.connectButton = document.getElementById('connect-btn') as HTMLButtonElement;
        this.disconnectButton = document.getElementById('disconnect-btn') as HTMLButtonElement;
        this.statusElement = document.getElementById('connection-status') as HTMLDivElement;
        this.statusText = this.statusElement.querySelector('.status-text') as HTMLSpanElement;
        this.serverList = document.getElementById('server-list') as HTMLDivElement;
        this.filterButtons = document.querySelectorAll('.filter-button');

        this.notifications = new NotificationManager();

        this.initializeUI();
        this.setupEventListeners();
        this.restoreState();
    }

    private async initializeUI() {
        // In a full implementation, fetch server list from API
        const demoServers: VPNServer[] = [
            {
                id: '1',
                name: 'US Server 1',
                host: 'us1.protonvpn.com',
                port: 443,
                country: 'US',
                load: 45,
                features: ['free', 'p2p']
            },
            {
                id: '2',
                name: 'Netherlands Server 1',
                host: 'nl1.protonvpn.com',
                port: 443,
                country: 'NL',
                load: 32,
                features: ['secure-core', 'tor']
            }
        ];

        this.renderServerList(demoServers);
        await this.checkAuthStatus();
    }

    private renderServerList(servers: VPNServer[]) {
        const filteredServers = this.currentFilter === 'all' 
            ? servers 
            : servers.filter(server => server.features?.includes(this.currentFilter));

        this.serverList.innerHTML = '';
        filteredServers.forEach(server => {
            const serverElement = document.createElement('div');
            serverElement.className = 'server-item';
            serverElement.innerHTML = `
                <div class="server-icon">
                    <span class="material-icons">public</span>
                </div>
                <div class="server-info">
                    <h3>${server.name}</h3>
                    <p>${server.country}</p>
                </div>
                <div class="server-stats">
                    <div>Load: ${server.load}%</div>
                    ${server.features ? `<div>${server.features.join(' • ')}</div>` : ''}
                </div>
            `;
            serverElement.addEventListener('click', () => this.selectServer(server));
            this.serverList.appendChild(serverElement);
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
        this.filterButtons.forEach(button => {
            button.addEventListener('click', () => {
                this.filterButtons.forEach(btn => btn.classList.remove('active'));
                button.classList.add('active');
                this.currentFilter = button.dataset.filter || 'all';
                this.initializeUI();
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
}

// Initialize the VPN client UI when the DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new VPNClientUI();
});