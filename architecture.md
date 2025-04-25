# Architecture Overview

## System Components

### 0. Extension Directory Structure
The project contains two extension-related directories:

1. `extension/` - Contains the built/compiled extension files that are loaded by Electron
2. `proton-vpn-browser-extension/` - Source code submodule, not to be modified

IMPORTANT: Never modify the `proton-vpn-browser-extension/` directory as it is a Git submodule containing the official source code. All development should work with the built extension in the `extension/` directory.

### 1. Extension Host (electron-main.js)
The main Electron application that loads and hosts the Proton VPN browser extension. Key responsibilities:
- Loading the extension from the `extension/` directory
- Managing application lifecycle
- Creating browser window with proper security settings
- Initializing the local proxy server

```
[Extension Host]
    ├── Loads extension
    ├── Creates window
    └── Initializes proxy server
```

### 2. Extension Bridge (preload.js)
A secure bridge between the extension and desktop components. Implements only necessary Chrome extension APIs:
- `chrome.proxy` API for proxy configuration
- `chrome.privacy` API for WebRTC handling
- `chrome.action/browserAction` API for UI updates

The bridge avoids re-implementing APIs already provided by Electron's extension support, such as:
- Storage APIs
- Runtime messaging
- Basic extension functionality

```
[Extension Bridge]
    ├── Proxy API
    │   ├── settings.set()
    │   ├── settings.get()
    │   ├── settings.clear()
    │   └── onProxyError
    │
    ├── Privacy API
    │   └── webRTCIPHandlingPolicy
    │
    └── Action API
        └── Badge updates
```

### 3. Local Proxy Server (server.js)
A lightweight proxy server that handles traffic forwarding. Features:
- Proxy configuration endpoint (/proxy/configure)
- Status endpoint (/status)
- Main proxy handler with bypass support
- Timeout and error handling
- Authentication forwarding

```
[Local Proxy Server]
    ├── Express App
    │   ├── /proxy/configure
    │   └── /status
    │
    ├── Proxy Handler
    │   ├── Direct connections
    │   └── Proxy forwarding
    │
    └── Security
        ├── Localhost only
        ├── Timeouts
        └── Error handling
```

## Data Flow

1. Extension Configuration Flow:
```
Extension -> chrome.proxy.settings.set() -> Bridge -> HTTP POST to /proxy/configure -> Local Proxy Server
```

2. Traffic Flow:
```
Application -> Local Proxy (2080) -> Authentication Check -> Bypass Check -> VPN Proxy Server
```

3. Error Handling Flow:
```
Proxy Error -> Local Server -> Bridge -> Extension -> UI Update
```

## Security Considerations

1. Isolation
- Extension runs in isolated context
- Preload script exposes minimal APIs
- Local proxy only accepts localhost connections

2. Authentication
- Proxy credentials handled securely
- Headers forwarded properly
- No credential storage in proxy server

3. Network Security
- Proper bypass list handling
- WebRTC leak prevention
- Timeout handling
- Private network protection

## Development Guidelines

1. Extension Integration
- Don't modify extension code
- Use Electron's extension API when possible
- Minimize bridge API surface
- Never edit the proton-vpn-browser-extension/ source submodule
- Work only with the built extension in extension/

2. Proxy Server
- Keep it focused on proxying
- Handle errors gracefully
- Maintain security checks

3. Testing
- Test bypass patterns
- Verify authentication flow
- Check timeout handling
- Validate error cases

## Source Control

1. Extension Management
- The extension/ directory contains the built extension files used by the application
- The proton-vpn-browser-extension/ directory is a Git submodule and should not be committed
- Updates to the extension should be handled by updating the submodule reference
- Local changes should never be made to the extension source code