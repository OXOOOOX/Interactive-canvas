import { defineConfig } from 'vite'
import http from 'node:http'
import https from 'node:https'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import { proxyChatStream } from './server/index.js'

const port = Number(process.env.PORT || 8080)
const host = '0.0.0.0'

function readJsonBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error('Request body is too large.'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text ? JSON.parse(text) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

function createDoubaoTtsProxyPlugin() {
  return {
    name: 'doubao-tts-proxy',
    configureServer(server) {
      server.middlewares.use('/api/doubao-tts', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' })
          return
        }

        let body
        try {
          body = await readJsonBody(req)
        } catch (error) {
          sendJson(res, 400, { error: error.message })
          return
        }

        const endpoint = body.endpoint || 'https://openspeech.bytedance.com/api/v3/tts/unidirectional'
        const apiKey = body.apiKey || ''
        const resourceId = body.resourceId || 'seed-tts-2.0'
        const requestId = body.requestId || randomUUID()
        const payload = body.payload

        if (!apiKey || !payload) {
          sendJson(res, 400, { error: 'Missing Doubao TTS apiKey or payload.' })
          return
        }

        let upstream
        try {
          upstream = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Api-Key': apiKey,
              'X-Api-Resource-Id': resourceId,
              'X-Api-Request-Id': requestId,
            },
            body: JSON.stringify(payload),
          })
        } catch (error) {
          sendJson(res, 502, { error: error.message })
          return
        }

        const text = await upstream.text().catch(() => '')
        res.writeHead(upstream.status, {
          'Content-Type': upstream.headers.get('content-type') || 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(text)
      })
    },
  }
}

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
        const apiKey = requestUrl.searchParams.get('apiKey') || ''

        console.log('[doubao-proxy] Connection request:', {
          target,
          resourceId,
          hasApiKey: !!apiKey,
        })

        const targetUrl = new URL(target)

        const wsOptions = {
          headers: {
            'X-Api-Key': apiKey,
            'X-Api-Resource-Id': resourceId,
            'X-Api-Connect-Id': connectId,
          },
          agent: targetUrl.protocol === 'wss:' ? new https.Agent({ rejectUnauthorized: false }) : new http.Agent(),
        }

        console.log('[doubao-proxy] Connecting to upstream:', target)

        const upstream = new WebSocket(targetUrl.toString(), wsOptions)
        const pendingClientMessages = []

        const flushPendingClientMessages = () => {
          while (pendingClientMessages.length && upstream.readyState === WebSocket.OPEN) {
            const { data, isBinary } = pendingClientMessages.shift()
            upstream.send(data, { binary: isBinary })
          }
        }

        const closeBoth = () => {
          if (clientSocket.readyState === WebSocket.OPEN) clientSocket.close()
          if (upstream.readyState === WebSocket.OPEN) upstream.close()
        }

        clientSocket.on('message', (data, isBinary) => {
          if (upstream.readyState === WebSocket.OPEN) {
            upstream.send(data, { binary: isBinary })
            console.log('[doubao-proxy] Client -> Upstream:', data.byteLength, 'bytes, binary:', isBinary)
          } else {
            pendingClientMessages.push({ data, isBinary })
            console.log('[doubao-proxy] Queued client message:', data.byteLength, 'bytes, binary:', isBinary)
          }
        })

        upstream.on('error', (err) => {
          console.error('[doubao-proxy] Upstream error:', err.message)
        })

        upstream.on('close', (code, reason) => {
          console.log('[doubao-proxy] Upstream closed:', { code, reason: reason?.toString() })
        })

        // 先连接上游，成功后再绑定客户端消息处理
        upstream.on('open', () => {
          console.log('[doubao-proxy] Upstream connected')
          flushPendingClientMessages()

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

function createChatStreamProxyPlugin() {
  return {
    name: 'chat-stream-proxy',
    configureServer(server) {
      server.middlewares.use('/api/chat/stream', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' })
          return
        }
        await proxyChatStream(req, res)
      })
    },
  }
}

export default defineConfig({
  root: '.',
  publicDir: 'public',
  plugins: [createDoubaoTtsProxyPlugin(), createDoubaoAsrProxyPlugin(), createChatStreamProxyPlugin()],
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
