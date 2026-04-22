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
        // 根据认证模式选择默认的 Resource ID
        // 豆包流式语音识别模型 2.0 小时版：volc.seedasr.sauc.duration
        // 豆包流式语音识别模型 2.0 并发版：volc.seedasr.sauc.concurrent
        const defaultResourceId = 'volc.seedasr.sauc.duration'

        const requestUrl = new URL(req.url || '', 'http://localhost')
        const target = requestUrl.searchParams.get('target') || 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel'
        const resourceId = requestUrl.searchParams.get('resourceId') || defaultResourceId
        const connectId = requestUrl.searchParams.get('connectId') || randomUUID()
        const mode = requestUrl.searchParams.get('mode') || 'apiKey'
        const apiKey = requestUrl.searchParams.get('apiKey') || ''
        const appId = requestUrl.searchParams.get('appId') || ''
        const accessToken = requestUrl.searchParams.get('accessToken') || ''
        const secretKey = requestUrl.searchParams.get('secretKey') || ''

        console.log('[doubao-proxy] Connection request:', {
          target,
          resourceId,
          mode,
          hasApiKey: !!apiKey,
          hasAppId: !!appId,
          hasAccessToken: !!accessToken,
          hasSecretKey: !!secretKey,
        })

        // 构建目标 URL，可能需要添加认证参数
        const targetUrl = new URL(target)

        const wsOptions = {
          headers: mode === 'apiKey'
            ? {
                'X-Api-Key': apiKey,
                'X-Api-Resource-Id': resourceId,
                'X-Api-Connect-Id': connectId,
              }
            // 旧版认证 (AppID + AccessToken/SecretKey) - 需要正确的头名称
            : appId && accessToken
              ? {
                  'X-Api-App-Key': appId,
                  'X-Api-Access-Key': accessToken,
                  'X-Api-Resource-Id': resourceId,
                  'X-Api-Connect-Id': randomUUID(),
                }
              : {
                  'X-Api-App-Key': appId,
                  'X-Api-Secret-Key': secretKey,
                  'X-Api-Resource-Id': resourceId,
                  'X-Api-Connect-Id': randomUUID(),
                },
          agent: targetUrl.protocol === 'wss:' ? new https.Agent({ rejectUnauthorized: false }) : new http.Agent(),
        }

        // 旧版认证需要在 URL 中添加 appId 参数
        if (mode !== 'apiKey' && appId) {
          targetUrl.searchParams.set('appId', appId)
        }

        console.log('[doubao-proxy] Connecting to upstream:', target)

        const closeBoth = () => {
          if (clientSocket.readyState === WebSocket.OPEN) clientSocket.close()
          if (upstream.readyState === WebSocket.OPEN) upstream.close()
        }

        const upstream = new WebSocket(target, wsOptions)

        upstream.on('error', (err) => {
          console.error('[doubao-proxy] Upstream error:', err.message)
        })

        upstream.on('close', (code, reason) => {
          console.log('[doubao-proxy] Upstream closed:', { code, reason: reason?.toString() })
        })

        // 先连接上游，成功后再绑定客户端消息处理
        upstream.on('open', () => {
          console.log('[doubao-proxy] Upstream connected')

          // 等待 upstream 响应，监听可能的错误消息
          let upstreamErrorReceived = false
          upstream.on('message', (data, isBinary) => {
            console.log('[doubao-proxy] Upstream -> Client (first message):', data.byteLength, 'bytes')
            // 尝试解析是否为错误响应
            try {
              const bytes = new Uint8Array(data)
              console.log('[doubao-proxy] First message header:', Array.from(bytes.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' '))
            } catch (e) {}

            if (clientSocket.readyState === WebSocket.OPEN) {
              clientSocket.send(data, { binary: isBinary })
            }
          })

          clientSocket.on('message', (data, isBinary) => {
            if (upstream.readyState === WebSocket.OPEN) {
              upstream.send(data, { binary: isBinary })
              console.log('[doubao-proxy] Client -> Upstream:', data.byteLength, 'bytes, binary:', isBinary)
            }
          })
        })

        upstream.on('error', (err) => {
          console.error('[doubao-proxy] Upstream error:', err.message)
          closeBoth()
        })

        upstream.on('close', (code, reason) => {
          console.log('[doubao-proxy] Upstream closed:', { code, reason: reason?.toString() })
          closeBoth()
        })

        clientSocket.on('error', (err) => {
          console.error('[doubao-proxy] Client error:', err.message)
          closeBoth()
        })

        clientSocket.on('close', () => {
          console.log('[doubao-proxy] Client closed')
          closeBoth()
        })
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
    allowedHosts: ['interactive-canvas.zeabur.app'],
  },
  preview: {
    host,
    port,
    strictPort: true,
    allowedHosts: ['interactive-canvas.zeabur.app'],
  },
})
