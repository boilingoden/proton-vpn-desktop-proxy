const express = require('express');
const httpProxy = require('http-proxy');
const net = require('net');

class ProxyServer {
    constructor() {
        this.app = express();
        this.proxyTarget = null;
        this.proxyConfig = null;
        this.proxyAgent = null;
        this.bypassList = [];
        
        this.setupMiddleware();
        this.setupRoutes();
    }

    setupMiddleware() {
        this.app.use(express.json());
        // Only accept localhost connections
        this.app.use((req, res, next) => {
            if (req.hostname !== 'localhost' && req.hostname !== '127.0.0.1') {
                return res.status(403).send('Access denied');
            }
            next();
        });
    }

    setupRoutes() {
        // Proxy configuration endpoint
        this.app.post('/proxy/configure', (req, res) => {
            const config = req.body;
            
            if (config.mode === 'direct') {
                this.clearProxy();
                res.sendStatus(200);
                return;
            }

            if (!config.mode || !config.rules?.singleProxy) {
                res.status(400).send('Invalid proxy configuration');
                return;
            }

            try {
                this.configureProxy(config);
                res.sendStatus(200);
            } catch (error) {
                console.error('Failed to configure proxy:', error);
                res.status(500).send(error.message);
            }
        });

        // Status endpoint
        this.app.get('/status', (req, res) => {
            res.json({
                ready: true,
                hasProxy: !!this.proxyTarget,
                proxyConfig: this.proxyConfig
            });
        });

        // Main proxy handler
        this.app.all('*', async (req, res) => {
            if (!this.proxyTarget) {
                return res.status(503).send('Proxy not configured');
            }

            const targetHost = req.headers.host;
            if (targetHost && await this.shouldBypass(targetHost)) {
                console.log(`Bypassing proxy for: ${targetHost}`);
                // Direct connection for bypassed hosts
                return this.handleDirectRequest(req, res);
            }

            // Forward through proxy
            this.proxyAgent.web(req, res, {
                timeout: 30000, // 30 second timeout
                proxyTimeout: 31000
            });
        });
    }

    async shouldBypass(host) {
        if (!host || !this.bypassList?.length) return false;

        // Check bypass patterns
        for (const pattern of this.bypassList) {
            if (pattern.startsWith('*.')) {
                // Wildcard domain match
                if (host.endsWith(pattern.slice(1))) return true;
            } else if (pattern.includes('/')) {
                // CIDR notation - just bypass private networks
                if (this.isPrivateIP(host)) return true;
            } else {
                // Exact match
                if (host === pattern) return true;
            }
        }

        return false;
    }

    isPrivateIP(host) {
        // Simple check for private networks
        const privateRanges = [
            /^127\./,
            /^10\./,
            /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
            /^192\.168\./,
            /^localhost$/
        ];
        return privateRanges.some(range => range.test(host));
    }

    handleDirectRequest(req, res) {
        // For bypassed hosts, connect directly
        const options = {
            method: req.method,
            headers: { ...req.headers }
        };
        delete options.headers.host;

        const target = new URL(req.url, `http://${req.headers.host}`);
        const directReq = require(target.protocol.slice(0, -1)).request(target, options, directRes => {
            res.writeHead(directRes.statusCode, directRes.headers);
            directRes.pipe(res);
        });

        directReq.on('error', error => {
            console.error('Direct request error:', error);
            res.status(502).send('Direct connection failed');
        });

        if (req.body) {
            directReq.write(req.body);
        }
        directReq.end();
    }

    configureProxy(config) {
        const proxy = config.rules.singleProxy;
        this.proxyTarget = `${proxy.scheme}://${proxy.host}:${proxy.port}`;
        this.proxyConfig = config;
        this.bypassList = config.rules.bypassList || [];

        // Create or update proxy agent
        if (this.proxyAgent) {
            this.proxyAgent.close();
        }

        this.proxyAgent = httpProxy.createProxyServer({
            target: this.proxyTarget,
            secure: proxy.scheme === 'https',
            changeOrigin: true,
            xfwd: true
        });

        // Handle proxy errors
        this.proxyAgent.on('error', (err, req, res) => {
            console.error('Proxy error:', err);
            if (!res.headersSent) {
                if (err.code === 'ECONNREFUSED') {
                    res.status(502).send('Proxy connection refused');
                } else if (err.code === 'ETIMEDOUT') {
                    res.status(504).send('Proxy timeout');
                } else {
                    res.status(502).send('Proxy error');
                }
            }
        });

        // Handle proxy auth and response
        this.proxyAgent.on('proxyReq', (proxyReq, req, res) => {
            // Forward proxy authorization header
            if (req.headers['proxy-authorization']) {
                proxyReq.setHeader('Proxy-Authorization', req.headers['proxy-authorization']);
            }
        });

        this.proxyAgent.on('proxyRes', (proxyRes, req, res) => {
            // Handle proxy authentication errors
            if (proxyRes.statusCode === 407) {
                console.error('Proxy authentication failed');
            }
        });

        console.log('Proxy configured:', {
            target: this.proxyTarget,
            bypassListSize: this.bypassList.length
        });
    }

    clearProxy() {
        if (this.proxyAgent) {
            this.proxyAgent.close();
            this.proxyAgent = null;
        }
        this.proxyTarget = null;
        this.proxyConfig = null;
        this.bypassList = [];
        console.log('Proxy configuration cleared');
    }

    start(port) {
        return new Promise((resolve, reject) => {
            try {
                const server = this.app.listen(port, 'localhost', () => {
                    console.log(`Proxy server running on http://localhost:${port}`);
                    resolve();
                });

                // Handle server errors
                server.on('error', (error) => {
                    console.error('Server error:', error);
                    reject(error);
                });

                // Graceful shutdown
                const shutdown = () => {
                    console.log('Shutting down proxy server...');
                    this.clearProxy();
                    server.close(() => {
                        console.log('Proxy server shut down successfully');
                        process.exit(0);
                    });
                };

                process.on('SIGTERM', shutdown);
                process.on('SIGINT', shutdown);

            } catch (error) {
                console.error('Failed to start server:', error);
                reject(error);
            }
        });
    }
}

module.exports = ProxyServer;
