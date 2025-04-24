import { AuthConfig, VPNServer } from './types';
import { getAuthData, saveAuthData } from './utils';
import fetch, { Headers, RequestInit } from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';

const API_BASE = 'https://api.protonvpn.com/v2';
const MAX_RETRIES = 3;
const RETRY_DELAY = 500;

interface APIResponse<T> {
    Code?: number;
    error?: string;
    data?: T;
}

export class ProtonVPNAPI {
    private static async request<T>(
        endpoint: string,
        options: RequestInit = {},
        retryCount = 0
    ): Promise<APIResponse<T>> {
        const authData = getAuthData();
        const requestHeaders: Record<string, string> = {
            'Content-Type': 'application/json',
            'x-pm-appversion': 'Other'
        };

        if (authData?.accessToken) {
            requestHeaders['Authorization'] = `Bearer ${authData.accessToken}`;
        }

        try {
            const response = await fetch(`${API_BASE}${endpoint}`, {
                ...options,
                headers: requestHeaders
            });

            const data = await response.json() as APIResponse<T>;

            // Handle 401 Unauthorized - attempt token refresh
            if (response.status === 401 && retryCount < MAX_RETRIES) {
                const success = await ProtonVPNAPI.handleUnauthorized();
                if (success) {
                    // Retry with new token
                    return ProtonVPNAPI.request(endpoint, options, retryCount + 1);
                }
            }

            // Handle rate limiting
            if (response.status === 429 && retryCount < MAX_RETRIES) {
                const retryAfter = parseInt(response.headers.get('retry-after') || '2', 10);
                await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
                return ProtonVPNAPI.request(endpoint, options, retryCount + 1);
            }

            // Handle server errors
            if (response.status >= 500 && retryCount < MAX_RETRIES) {
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * Math.pow(2, retryCount)));
                return ProtonVPNAPI.request(endpoint, options, retryCount + 1);
            }

            return data;
        } catch (error) {
            if (retryCount < MAX_RETRIES) {
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * Math.pow(2, retryCount)));
                return ProtonVPNAPI.request(endpoint, options, retryCount + 1);
            }
            throw error;
        }
    }

    private static async handleUnauthorized(): Promise<boolean> {
        const authData = getAuthData();
        if (!authData?.refreshToken) return false;
        
        try {
            const response = await ProtonVPNAPI.request<{ token: AuthConfig }>('/auth/refresh', {
                method: 'POST',
                body: JSON.stringify({ refreshToken: authData.refreshToken })
            });

            if (response.Code === 1000 && response.data?.token) {
                const newAuthData = response.data.token;
                saveAuthData(newAuthData);
                return true;
            }
        } catch (error) {
            console.error('Token refresh failed:', error);
        }
        return false;
    }

    static async getServers(): Promise<VPNServer[]> {
        try {
            const response = await this.request<{ servers: VPNServer[] }>('/servers');
            
            if (!response.data?.servers) {
                throw new Error(response.error || 'Failed to fetch servers');
            }

            return response.data.servers.map(server => ({
                ...server,
                features: this.getServerFeatures(server)
            }));
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

    static async checkServerStatus(serverId: string): Promise<boolean> {
        try {
            const response = await this.request<{LogicalServers: Array<{ID: string; Status: number}>}>(
                `/vpn/v1/logicals?ID[]=${serverId}`
            );
            
            if (!response.data?.LogicalServers?.length) {
                return false;
            }

            return response.data.LogicalServers[0].Status === 1;
        } catch (error) {
            console.error('Failed to check server status:', error);
            return false;
        }
    }
}