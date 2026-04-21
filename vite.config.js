import { defineConfig } from 'vite'
import http from 'node:http'
import https from 'node:https'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'

const port = Number(process.env.PORT || 8080)
const host = '0.0.0.0'

function createDoubaoAsrProxyPlugin() {
  return {
    name: 'doubao-asr-proxy',
    configureServer(server) {
      const wss = new WebSocketServer({ noServer: true })

      server.httpServer?.on('upgrade', (req, socket, head) => {
        const url = req.url || ''
        if (!url.startsWith('/api/doubao-asr')) return

        wss.handleUpgrade(req, socket, head, (clientSocket) => {
          wss.emit('connection', clientSocket, req)
        })
      })

      wss.on('connection', (clientSocket, req) => {
        const requestUrl = new URL(req.url || '', 'http://localhost')
        const target = requestUrl.searchParams.get('target') || 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel'
        const resourceId = requestUrl.searchParams.get('resourceId') || 'volc.bigasr.sauc.duration'
        const connectId = requestUrl.searchParams.get('connectId') || randomUUID()
        const mode = requestUrl.searchParams.get('mode') || 'apiKey'
        const apiKey = requestUrl.searchParams.get('apiKey') || ''
        const appId = requestUrl.searchParams.get('appId') || ''
        const accessToken = requestUrl.searchParams.get('accessToken') || ''
        const secretKey = requestUrl.searchParams.get('secretKey') || ''

        const targetUrl = new URL(target)
        const wsOptions = {
          headers: mode === 'apiKey'
            ? {
                'X-Api-Key': apiKey,
                'X-Api-Resource-Id': resourceId,
                'X-Api-Connect-Id': connectId,
              }
            : {
                'X-Api-Resource-Id': resourceId,
                'X-Api-Request-Id': randomUUID(),
                'X-Api-App-Key': appId,
                ...(accessToken ? { 'X-Api-Access-Key': accessToken } : {}),
                ...(secretKey ? { 'X-Api-Secret-Key': secretKey } : {}),
              },
          agent: targetUrl.protocol === 'wss:' ? new https.Agent() : new http.Agent(),
        }

        const upstream = new WebSocket(target, wsOptions)

        const closeBoth = () => {
          if (clientSocket.readyState === WebSocket.OPEN) clientSocket.close()
          if (upstream.readyState === WebSocket.OPEN) upstream.close()
        }

        upstream.on('open', () => {
          clientSocket.on('message', (data, isBinary) => {
            if (upstream.readyState === WebSocket.OPEN) {
              upstream.send(data, { binary: isBinary })
            }
          })

          upstream.on('message', (data, isBinary) => {
            if (clientSocket.readyState === WebSocket.OPEN) {
              clientSocket.send(data, { binary: isBinary })
            }
          })
        })

        upstream.on('error', () => closeBoth())
        clientSocket.on('error', () => closeBoth())
        upstream.on('close', () => closeBoth())
        clientSocket.on('close', () => closeBoth())
      })
    },
  }
}

export default defineConfig({
  root: '.',
  publicDir: 'public',
  plugins: [createDoubaoAsrProxyPlugin()],
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    host,
    port,
    strictPort: true,
    open: false,
  },
  preview: {
    host,
    port,
    strictPort: true,
  },
})
