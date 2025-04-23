import { ipcRenderer } from 'electron';
import { VPNServer, VPNConnectionConfig, IPC_CHANNELS } from '../common/types';
import { getAuthData, saveAuthData, isTokenExpired, getProxyConfig } from '../common/utils';

class VPNClientUI {
    private connectButton: HTMLButtonElement;
    private disconnectButton: HTMLButtonElement;
    private statusElement: HTMLDivElement;
    private serverList: HTMLDivElement;
    private isConnected: boolean = false;
    private currentServer: VPNServer | null = null;

    constructor() {
        this.connectButton = document.getElementById('connect-btn') as HTMLButtonElement;
        this.disconnectButton = document.getElementById('disconnect-btn') as HTMLButtonElement;
        this.statusElement = document.getElementById('connection-status') as HTMLDivElement;
        this.serverList = document.getElementById('server-list') as HTMLDivElement;

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
                load: 45
            },
            {
                id: '2',
                name: 'Netherlands Server 1',
                host: 'nl1.protonvpn.com',
                port: 443,
                country: 'NL',
                load: 32
            }
        ];

        this.renderServerList(demoServers);
        await this.checkAuthStatus();
    }

    private renderServerList(servers: VPNServer[]) {
        this.serverList.innerHTML = '';
        servers.forEach(server => {
            const serverElement = document.createElement('div');
            serverElement.className = 'server-item';
            serverElement.innerHTML = `
                <h3>${server.name}</h3>
                <p>Country: ${server.country}</p>
                <p>Load: ${server.load}%</p>
            `;
            serverElement.addEventListener('click', () => this.selectServer(server));
            this.serverList.appendChild(serverElement);
        });
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
            alert('Please select a server first');
            return;
        }

        if (!await this.checkAuthStatus()) {
            const authResult = await this.handleAuth();
            if (!authResult) {
                return;
            }
        }

        try {
            const success = await ipcRenderer.invoke(IPC_CHANNELS.PROXY.SET, {
                host: this.currentServer.host,
                port: this.currentServer.port
            });

            if (success) {
                this.isConnected = true;
                this.updateUI(true);
            } else {
                alert('Failed to connect to VPN');
            }
        } catch (error) {
            console.error('Connection error:', error);
            alert('Failed to connect to VPN');
        }
    }

    private async disconnect() {
        try {
            const success = await ipcRenderer.invoke(IPC_CHANNELS.PROXY.CLEAR);
            if (success) {
                this.isConnected = false;
                this.updateUI(false);
            } else {
                alert('Failed to disconnect from VPN');
            }
        } catch (error) {
            console.error('Disconnection error:', error);
            alert('Failed to disconnect from VPN');
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

    private updateUI(isConnected: boolean) {
        this.statusElement.textContent = isConnected ? 'Connected' : 'Disconnected';
        this.statusElement.className = isConnected ? 'status-connected' : 'status-disconnected';
        this.connectButton.style.display = isConnected ? 'none' : 'block';
        this.disconnectButton.style.display = isConnected ? 'block' : 'none';
    }
}

// Initialize the VPN client UI when the DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new VPNClientUI();
});