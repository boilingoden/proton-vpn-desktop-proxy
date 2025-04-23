import { AuthConfig, VPNServer } from './types';
import { getAuthData } from './utils';

const API_BASE = 'https://api.protonvpn.com/v2';

interface APIResponse<T> {
    Code?: number;
    error?: string;
    data?: T;
}

export class ProtonVPNAPI {
    private static async request<T>(
        endpoint: string,
        options: RequestInit = {}
    ): Promise<APIResponse<T>> {
        const authData = getAuthData();
        const headers = new Headers({
            'Content-Type': 'application/json',
            ...(authData?.accessToken 
                ? { 'Authorization': `Bearer ${authData.accessToken}` }
                : {})
        });

        const response = await fetch(`${API_BASE}${endpoint}`, {
            ...options,
            headers
        });

        const data = await response.json();
        return data;
    }

    static async getServers(): Promise<VPNServer[]> {
        try {
            const response = await this.request<{ servers: VPNServer[] }>('/servers');
            
            if (response.error) {
                throw new Error(response.error);
            }

            return response.data?.servers.map(server => ({
                ...server,
                features: this.getServerFeatures(server)
            })) || [];
        } catch (error) {
            console.error('Failed to fetch servers:', error);
            return [];
        }
    }

    private static getServerFeatures(server: VPNServer): string[] {
        const features: string[] = [];
        
        if (server.tier === 0) features.push('free');
        if (server.features?.includes('p2p')) features.push('p2p');
        if (server.features?.includes('tor')) features.push('tor');
        if (server.features?.includes('secure-core')) features.push('secure-core');
        
        return features;
    }

    static async refreshToken(refreshToken: string): Promise<AuthConfig | null> {
        try {
            const response = await this.request<{ token: AuthConfig }>('/auth/refresh', {
                method: 'POST',
                body: JSON.stringify({ refreshToken })
            });

            if (response.error || !response.data?.token) {
                throw new Error(response.error || 'Invalid refresh token response');
            }

            return response.data.token;
        } catch (error) {
            console.error('Failed to refresh token:', error);
            return null;
        }
    }

    static async getProxyToken(duration: number = 3600): Promise<{ username: string; password: string; expiresIn: number } | null> {
        try {
            const response = await this.request<{
                Code: number;
                Username: string;
                Password: string;
                Expire: number;
            }>(`/vpn/browser/token?Duration=${duration}`);

            if (response.Code !== 1000 || !response.data) {
                throw new Error('Invalid proxy token response');
            }

            return {
                username: response.data.Username,
                password: response.data.Password,
                expiresIn: response.data.Expire
            };
        } catch (error) {
            console.error('Failed to get proxy token:', error);
            return null;
        }
    }
}