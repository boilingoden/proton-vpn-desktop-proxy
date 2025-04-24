# Proton VPN Desktop Proxy

A desktop application that provides secure proxy functionality ported from the Proton VPN Browser Extension. This application allows you to route your traffic through Proton's secure proxy servers without requiring a full VPN connection.

## Architecture

This application is built using Electron and follows the same architecture as the Proton VPN Browser Extension but adapted for desktop use:

### Core Components

1. **Main Process** (`src/main/main.ts`)
   - Handles window management
   - Manages system proxy settings
   - Handles IPC communication
   - Monitors network connectivity
   - Implements proxy authentication
   - Manages proxy server status checks

2. **Renderer Process** (`src/renderer/`)
   - Implements the user interface
   - Handles user interactions
   - Manages connection state
   - Handles authentication flow
   - Implements server selection and filtering

3. **Common** (`src/common/`)
   - Shared types and interfaces
   - API client implementation
   - Authentication utilities
   - Configuration management

### Key Features

- **HTTP/HTTPS Proxy Support**: Uses HTTP/HTTPS proxy protocols to route traffic through Proton servers
- **Authentication**: OAuth2-based authentication with Proton's servers
- **Secure Core**: Routes traffic through multiple secure servers
- **Kill Switch**: Blocks all traffic if proxy connection drops
- **Split Tunneling**: Allows excluding certain apps/domains from proxy
- **Auto-Connect**: Automatically connects to last used server on startup

### Security Features

1. **Proxy Authentication**
   - Uses short-lived credentials (1-hour tokens)
   - Automatic credential refresh
   - Secure token storage

2. **Connection Security**
   - Encrypted proxy connections
   - Certificate validation
   - Automatic reconnection on network changes
   - Network leak prevention

3. **Privacy Protection**
   - No logs policy
   - Anonymous credentials
   - IP address protection

### Network Architecture

```
Desktop App <-> Proton Proxy Server <-> Internet
              (Encrypted Connection)

Authentication Flow:
1. User -> Proton Account Server (OAuth)
2. App receives access token
3. App exchanges token for proxy credentials
4. App configures system proxy with credentials
```

### Important Implementation Notes

1. This is NOT a VPN implementation. It does not:
   - Create network interfaces
   - Use VPN protocols (OpenVPN, WireGuard, etc.)
   - Modify system routing tables
   - Require elevated privileges

2. This IS a proxy client that:
   - Uses HTTP/HTTPS proxy protocols
   - Routes traffic through Proton's proxy servers
   - Provides encryption via HTTPS
   - Works at the application level

### Configuration

The application supports the following settings:

- Auto-connect on startup
- Kill switch for connection drops
- Split tunneling for selective routing
- Server selection preferences
- Alternative routing for restricted networks

## Development

### Prerequisites

- Node.js 16+
- npm or yarn
- Electron development environment

### Building

```bash
# Install dependencies
npm install

# Development build
npm run dev

# Production build
npm run build
```

### Project Structure

```
src/
├── main/             # Main process code
├── renderer/         # UI and renderer process code
├── common/           # Shared code and types
└── preload/         # Preload scripts for Electron

assets/              # Application assets
build/               # Build configuration

proton-vpn-browser-extension/  # Original extension code (included as submodule)
```

The original Proton VPN Browser Extension code is included as a Git submodule in the `proton-vpn-browser-extension/` directory. This allows for easy reference during development while maintaining a clean separation between the extension and desktop application code. The submodule provides direct access to the original implementation patterns, helping ensure compatibility and consistent behavior with the browser extension.

## Credits

This project is based on the Proton VPN Browser Extension, adapted for desktop use. All credit for the core functionality and security architecture goes to the Proton VPN team.

## Security Considerations

- The application uses the system proxy settings, which means it affects all applications that respect system proxy settings
- The kill switch feature blocks internet access when enabled if the proxy connection drops
- Users should be aware that DNS queries are routed through the proxy for privacy
- System proxy settings require careful handling to prevent leaks

## License

Same as original Proton VPN Browser Extension