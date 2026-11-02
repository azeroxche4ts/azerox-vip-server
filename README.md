# AZEROX VIP License Server

Central License and Key Management Server for AZEROX VIP.

## Features
- **Admin Dashboard**: Web UI for key generation, real-time monitoring, and license management.
- **Dedicated VIP Key Management**: Cryptographic VIP keys (`AZEROX-VIP-XXXX-XXXX-XXXX-XXXX`).
- **Product Isolation**: Exclusively validates and activates keys for **AZEROX VIP**.
- **Device Binding & Security**: Configurable activation limits, session tokens, and instant remote revocation.
- **Full Key Lifecycle**: Generate, Pause, Resume, Revoke, Delete, and custom duration controls (1h, 1d, 7d, 30d).
- **SQLite Database**: Native SQLite with zero extra dependencies and automatic migrations.

## Quick Start

### 1. Requirements
- Node.js v22+ (tested on Node v22/v24)
- npm

### 2. Install Dependencies
```bash
npm install
```

### 3. Start Server
```bash
# Start license authority:
npm start

# Run tests:
npm test
```

## API Endpoints

### Client Endpoints (Used by AZEROX VIP APK)
- `POST /api/activate` or `POST /api/license/activate`
  - Body: `{"key": "AZEROX-VIP-...", "device_id": "...", "product_name": "AZEROX VIP"}`
- `POST /api/validate` or `POST /api/license/validate`
  - Body: `{"key": "AZEROX-VIP-...", "device_id": "...", "session_token": "..."}`
- `GET /api/health`

### Admin Endpoints
- `POST /api/admin/login`
- `GET /api/admin/keys`
- `POST /api/keys/generate`
- `POST /api/keys/:id/pause`
- `POST /api/keys/:id/resume`
- `POST /api/keys/:id/revoke`
- `DELETE /api/keys/:id`
- `GET /api/admin/stats`
