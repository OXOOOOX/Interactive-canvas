#!/usr/bin/env node

/**
 * Interactive Canvas - Cross-platform Startup Script
 * Run via: npm start
 */

import { existsSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const publicDir = join(rootDir, 'public');
const localConfigPath = join(publicDir, 'local.config.js');

const DEFAULT_LOCAL_CONFIG = `// Interactive Canvas - Local Configuration
// Please edit sk-xxxxxxxx with your actual API key
window.__LOCAL_CONFIG__ = {
  DASHSCOPE_KEY: "sk-xxxxxxxxxxxxxxxxxxxxxxxx",
  DEFAULT_LLM_ENDPOINT: "",
  DEFAULT_STT_ENDPOINT: "",
  DEFAULT_TTS_ENDPOINT: "",
};
`;

function ensureLocalConfig() {
  const publicDirExists = existsSync(publicDir);
  if (!publicDirExists) {
    console.log('[Setup] Creating public directory...');
    execSync(`mkdir -p "${publicDir}"`, { stdio: 'inherit' });
  }

  if (!existsSync(localConfigPath)) {
    console.log('[Setup] Creating default local.config.js...');
    writeFileSync(localConfigPath, DEFAULT_LOCAL_CONFIG, 'utf-8');
    console.log('[Setup] Created public/local.config.js');
    console.log('[Info] Please edit public/local.config.js with your API key after startup.');
    console.log('');
  }
}

function ensureDependencies() {
  const nodeModulesPath = join(rootDir, 'node_modules');
  if (!existsSync(nodeModulesPath)) {
    console.log('[Setup] Installing dependencies...');
    execSync('npm install', { stdio: 'inherit', cwd: rootDir });
    console.log('[Setup] Dependencies installed.');
    console.log('');
  }
}

function startDevServer() {
  console.log('[Starting] Launching Vite dev server...');
  console.log('[Info] The browser will open automatically at http://localhost:5173');
  console.log('[Info] Press Ctrl+C to stop the server');
  console.log('');

  const viteProcess = spawn('npm', ['run', 'dev'], {
    stdio: 'inherit',
    cwd: rootDir
  });

  viteProcess.on('error', (err) => {
    console.error('[Error] Failed to start dev server:', err.message);
    process.exit(1);
  });

  viteProcess.on('exit', (code) => {
    process.exit(code || 0);
  });
}

// Main execution
console.log('============================================');
console.log('  Interactive Canvas - One Key Startup');
console.log('============================================');
console.log('');

ensureLocalConfig();
ensureDependencies();
startDevServer();
