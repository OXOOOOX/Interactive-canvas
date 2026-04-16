#!/bin/bash

echo "============================================"
echo "  Interactive Canvas - One Key Startup"
echo "============================================"
echo ""

# Check if public/local.config.js exists
if [ ! -f "public/local.config.js" ]; then
    echo "[Setup] Creating default local.config.js..."
    cat > "public/local.config.js" << 'EOF'
// Interactive Canvas - Local Configuration
// Please edit sk-xxxxxxxx with your actual API key
window.__LOCAL_CONFIG__ = {
  DASHSCOPE_KEY: "sk-xxxxxxxxxxxxxxxxxxxxxxxx",
  DEFAULT_LLM_ENDPOINT: "",
  DEFAULT_STT_ENDPOINT: "",
  DEFAULT_TTS_ENDPOINT: "",
};
EOF
    echo "[Setup] Created public/local.config.js"
    echo "[Info] Please edit public/local.config.js with your API key after startup."
    echo ""
fi

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "[Setup] Installing dependencies..."
    npm install
    if [ $? -ne 0 ]; then
        echo "[Error] Failed to install dependencies. Please check npm is installed."
        exit 1
    fi
    echo "[Setup] Dependencies installed."
    echo ""
fi

echo "[Starting] Launching Vite dev server..."
echo "[Info] The browser will open automatically at http://localhost:5173"
echo "[Info] Press Ctrl+C to stop the server"
echo ""

npm run dev
