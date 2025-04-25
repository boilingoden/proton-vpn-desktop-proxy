# Proton VPN Desktop Proxy

A desktop proxy bridge that enables Proton VPN browser extension to provide system-wide proxy capabilities for desktop applications.

## Overview

This application acts as a bridge between the Proton VPN browser extension and desktop applications, allowing any application that supports manual proxy configuration to use Proton VPN's secure proxy servers.

```
[Proton VPN Extension] <-> [Electron Extension Bridge] <-> [Desktop App] <-> [Local Proxy Server] <-> [Applications]
```

## Features

- Load and run Proton VPN extension in Electron
- Local proxy server (default port 2080) for forwarding traffic
- Support for proxy authentication
- Bypass lists for local/private networks
- Proper timeout and error handling
- WebRTC leak prevention

## Installation

1. Clone the repository:
```bash
git clone https://github.com/protonvpn/proton-vpn-desktop-proxy
cd proton-vpn-desktop-proxy
```

2. Install dependencies:
```bash
npm install
```

## Usage

1. Start the application:
```bash
npm start
```

This will:
- Start the local proxy server on port 2080
- Load the Proton VPN extension
- Open the application window

2. Configure your applications to use the proxy:
   - Proxy Host: `localhost` or `127.0.0.1`
   - Proxy Port: `2080`
   - Proxy Type: `HTTPS`

## Development

1. Run in development mode with debugging:
```bash
npm run dev
```

2. Run proxy server standalone (for testing):
```bash
npm run proxy
```

## Architecture

See [architecture.md](architecture.md) for detailed information about the system design and components.

## Contributing

Please read [CONTRIBUTING.md](CONTRIBUTING.md) for details on our code of conduct and the process for submitting pull requests.

## License

This project is licensed under the GPL-3.0 License - see the [LICENSE](LICENSE) file for details.

## Security

For security concerns, please email security@proton.me