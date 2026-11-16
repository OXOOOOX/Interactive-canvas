# 画布的服务器自动部署

生产入口保持 `https://canvas.sdspeed.com.cn`。GitHub `main` 更新后，Actions 增量同步
确切提交的源码，在现有服务器运行 `npm ci`、`npm test` 和生产构建，再发布 Docker 镜像。
电脑不需要常开。构建失败时继续运行上一版；激活失败会尝试恢复上一版程序。

## 当前部署范围

此次基于原线上提交 `9dfea20d004ee7ad5aca55ca30203fe7d8a841fb`，保留 Node 20.20.2
运行环境、Vite 前端和 Node 的聊天、语音代理。原 Dockerfile 作为运行环境配方基准保留。
构建基础镜像已在服务器本地准备并固定 ID，不依赖每次从 Zeabur 拉取镜像。

画布、配置和全局记忆主要在用户浏览器 localStorage；附件在 IndexedDB。
保留原 HTTPS 域名才能继续访问同一浏览器的数据。服务端没有业务数据库和持久化文件卷。
本次按要求不创建迁移数据备份，当前自动发布也不生成服务器业务数据备份；旧程序版本保留用于回退。
服务端内存里的免费额度计数会随重启重置，进行中的聊天或语音连接会在切换时中断。

本地另外存在尚未发布的 PostgreSQL/SMTP 账户系统改动，本次没有包含。
这套发布脚本会拒绝含 `pg` 依赖或 `server/auth` 的版本；发布账户系统前，应先配置数据库、
邮件、持久化目录和独立迁移验证，再有针对性地更新部署约定。该检查不是通用的数据迁移检测器。

## GitHub 设置

| 类型 | 名称 |
|---|---|
| Variables | `CANVAS_DEPLOY_ENABLED`、`CANVAS_DEPLOY_HOST`、`CANVAS_DEPLOY_PORT`、`CANVAS_DEPLOY_USER` |
| Secrets | `CANVAS_SSH_PRIVATE_KEY`、`CANVAS_SSH_KNOWN_HOSTS` |

沿用同一台服务器已有部署私钥，各仓库分别保存 Secret。`CANVAS_DEPLOY_ENABLED=true` 才运行服务器部署任务。
推送 `main` 会自动激活；在 Actions 手动运行时，默认 `activate=false` 只构建和测试，勾选后才发布。
PR 仅做无秘密的部署源码检查。`GH_TOKEN` 使用 GitHub 提供的任务令牌，不用另建同名 Secret。

构建限制为 1 GiB 内存、1 个 CPU，并配合 RDB/闪电岛的构建锁。
运行中的画布容器上限为 512 MiB 内存、1 个 CPU。新项目也应沿用构建互斥机制。

## 服务器目录

| 内容 | 位置 |
|---|---|
| 项目根目录 | `/opt/canvas` |
| 当前 / 上一成功版本 | `/opt/canvas/current`、`/opt/canvas/previous` |
| 版本源码与构建记录 | `/opt/canvas/releases/<完整 Git SHA>` |
| 用户变量 | `/opt/canvas/shared/runtime.env`，root 所有、权限 600 |
| 固定基础镜像配置 | `/opt/canvas/shared/runtime-image.json` |
| 最近发布结果 | `/opt/canvas/shared/last-release.json` |
| 发布日志 | 对应版本目录下 `activation.log`；构建输出见 Actions |
| 网站上游 | `127.0.0.1:4190` → 容器 `8080` |

共享 Caddy 网关 `/opt/site-gateway/Caddyfile` 负责域名和 HTTPS；普通代码发布不改 DNS 或网关。
不要停止或删除其他项目仍在使用的 K3s。

## 用户变量和凭据

后端变量在 `runtime.env` 中以 `KEY=value` 保存，采用 Compose raw 格式，不额外加 shell 引号。
它们不进入构建、不上传 GitHub。浏览器页面里用户自行填写的配置仍由原浏览器保存。

新版本已停止跟踪 `.env`。快照工具也拒绝真实环境文件、`public/local.config.js`、私钥等内容。
`VITE_*` 会成为前端构建输入，不应放入秘密；历史 Git 中出现过的凭据需要在相应提供商控制台轮换，
仅删除当前文件不能消除历史暴露。本次没有更换用户的服务凭据，也没有改写 Git 历史。

编辑变量应避开正在发布的时段，保存后运行下面的命令使配置生效（会短暂停止画布应用）：

```sh
sudo python3 - <<'PY'
import importlib.util,json,pathlib
p=pathlib.Path('/opt/canvas/current').resolve()
s=importlib.util.spec_from_file_location('release',p/'release.py')
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
with (m.SHARED/'release.lock').open('w') as lock:
    m.fcntl.flock(lock,m.fcntl.LOCK_EX)
    assert pathlib.Path('/opt/canvas/current').resolve()==p, 'Version changed; retry'
    env=m.load_release(p,json.loads((m.SHARED/'runtime-image.json').read_text()))
    m.compose(p,env,'up','-d','--no-deps','--force-recreate','app')
    m.healthy(p,env)
print('Canvas service checks passed')
PY
```

## 验证与回退

真实健康端点是 `/api/health`，必须返回 JSON `{ "ok": true }`。
未知 GET 地址可能返回 HTML 和 200，不能只用状态码判断。
发布还核对首页、JS/CSS、语音模型文件内容，以及后端对无效请求的拒绝行为。
这些检查不发送付费 AI 请求、不调用实际语音服务，不能替代业务功能验收。

回退已验证的上一版：

```sh
sudo -n bash /opt/canvas/previous/deploy.sh /opt/canvas/previous
```

这会更换程序版本，不清空浏览器数据，也不撤销用户变量。当前版本与上一版都必须保留有效构建记录。
变更原 Dockerfile 的运行环境配方时，需先更新固定基础镜像和对应指纹，不能直接绕过检查。
