@echo off
chcp 65001 >nul
title Interactive Canvas - Startup

echo ============================================
echo   Interactive Canvas - One Key Startup
echo ============================================
echo.

REM Check if public/local.config.js exists
if not exist "public\local.config.js" (
    echo [Setup] Creating default local.config.js...
    (
        echo // Interactive Canvas - Local Configuration
        echo // Please edit sk-xxxxxxxx with your actual API key
        echo window.__LOCAL_CONFIG__ = {
        echo   DASHSCOPE_KEY: "sk-xxxxxxxxxxxxxxxxxxxxxxxx",
        echo   DEFAULT_LLM_ENDPOINT: "",
        echo   DEFAULT_STT_ENDPOINT: "",
        echo   DEFAULT_TTS_ENDPOINT: "",
        echo };
    ) > "public\local.config.js"
    echo [Setup] Created public\local.config.js
    echo [Info] Please edit public\local.config.js with your API key after startup.
    echo.
)

REM Check if node_modules exists
if not exist "node_modules" (
    echo [Setup] Installing dependencies...
    call npm install
    if errorlevel 1 (
        echo [Error] Failed to install dependencies. Please check npm is installed.
        pause
        exit /b 1
    )
    echo [Setup] Dependencies installed.
    echo.
)

echo [Starting] Launching Vite dev server...
echo [Info] The browser will open automatically at http://localhost:5173
echo [Info] Press Ctrl+C to stop the server
echo.

call npm run dev
