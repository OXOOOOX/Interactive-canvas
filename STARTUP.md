# Interactive Canvas - Startup Guide

## One-Key Startup

### Windows
Double-click `start.bat` or run:
```bash
start.bat
```

### macOS / Linux
Run:
```bash
./start.sh
```

### Alternative: Using npm
```bash
npm start
```

## What the startup script does

1. **Creates `public/local.config.js`** if it doesn't exist (with placeholder values)
2. **Installs dependencies** if `node_modules` doesn't exist
3. **Starts the Vite dev server** - browser opens automatically at http://localhost:5173

## First Time Setup

After the first startup, edit `public/local.config.js` with your actual API keys:

```javascript
window.__LOCAL_CONFIG__ = {
  DASHSCOPE_KEY: "sk-your-actual-api-key-here",
  DEFAULT_LLM_ENDPOINT: "",
  DEFAULT_STT_ENDPOINT: "",
  DEFAULT_TTS_ENDPOINT: "",
};
```

## Manual Start

If you prefer to start manually:

```bash
# Install dependencies (first time only)
npm install

# Start dev server
npm run dev

# Or build for production
npm run build
```

## Stop the Server

Press `Ctrl+C` in the terminal to stop the server.
