# AGENTS.md — 开发者与 AI 代理协作指南

> 修改功能、运行行为、配置、架构或界面操作流程时，在同一次变更里同步更新 **AGENTS.md** 和 **README.md**。界面变更时核对 README 里的按钮、状态和截图，按需用演示数据重截。

## 项目定位与行为

- **平台与入口**。Windows 下的 Clash Verge Rev / mihomo 插件，使用 Node.js 20 及以上。命令行入口是 `npm start`，也可用 `start.bat` 或 `start-silent.vbs`。本机面板默认在 `http://127.0.0.1:7898/`。
- **规则优先级**。首条 `MATCH` 之前的已有域名、规则集、GEOIP 等规则先匹配。其后是 AutoRoute 生成的域名规则集、QUIC、其他 UDP 和 TCP 兜底。首条 `MATCH` 之后的旧规则仍放在兜底之后。
- **首连处理**。未匹配的 TCP 连接由 `AutoRoute-Hook`（本机 SOCKS5，默认 7899）暂持。程序在目标组的显式成员内经 mihomo 测试采样主机 HTTP/HTTPS 根地址，按首个成功结果和 `raceGraceMs` 竞速决定出口。测速失败、暂停或排除的域名走原兜底。
- **分配与热更新**。使用公共后缀列表将 `a.cdn.example.co.uk` 归并为 `example.co.uk`。规则写入 `%APPDATA%\io.github.clash-verge-rev.clash-verge-rev\autoroute\p<port>-<节点标识>.list`，通过 `PUT /providers/rules/<provider>` 刷新。后续同主域名的 TCP / UDP 由 mihomo 匹配已加载规则。未分配的 UDP 443 会被拒绝，其他未分配 UDP 走原出口。
- **自动、锁定和排除**。`auto` 记录按延迟阈值在后台迁移。`locked` 记录保留所选节点，手动重测只更新测速数据。排除域名保留状态记录，从下发、复测和导出中移除。更换配置后失效的节点仍可在面板详情中更换。
- **接入状态**。面板依次检查内核、脚本是否写入及当前版本是否加载、规则模式、规则集刷新和兜底组是否已选择 Hook。写入、换组或移除脚本后需要在 Clash Verge Rev 重新应用订阅。退出仅关闭服务，恢复原规则需移除并重新应用。
- **导出**。读取运行时 `clash-verge.yaml`，剥离插件注入的规则和 providers，保留原规则及原 `MATCH`，插入可引用的锁定域名规则。导出的 YAML 提供待合并的 `rules` 和 `rule-providers`。

## 文件与职责

| 文件 | 职责 |
| --- | --- |
| `src/index.js` | 初始化配置、预建规则文件，启动 Hook、面板、托盘和定时任务。 |
| `src/config.js`、`src/store.js` | 读写 `data/config.json`、维护和持久化 `data/state.json`。 |
| `src/mihomo.js`、`src/groups.js` | 命名管道 / HTTP 控制客户端，同步规则、节点端口、脚本版本、规则模式和兜底组状态。 |
| `src/domain.js` | 基于 `tldts` 归并主域名，清洗域名输入和后缀匹配。 |
| `src/engine.js`、`src/prober.js` | 分配、复测、锁定、过期和连接统计，控制测速并发和竞速结果。 |
| `src/socks.js`、`src/hook.js` | SOCKS5 首连暂持、健康检查和转发。 |
| `src/rules.js`、`src/verge-script.js` | 规则文件预建与同步，生成和安装 / 移除全局扩展脚本。 |
| `src/exporter.js` | 生成或保存清理后的 Clash 规则 YAML。 |
| `src/panel.js` | 仅监听回环地址的面板和管理 API，校验 Host 和来源。 |
| `web/index.html`、`web/panel.css`、`web/panel.js` | 中文操作界面、响应布局和交互，无需前端构建。 |
| `src/tray.js`、`src/autostart.js`、`src/logger.js` | Windows 托盘、登录自启、控制台和本地日志。 |
| `test/run-integration.js`、`test/run-regressions.js` | 集成和回归测试。 |
| `docs/screenshots/` | README 使用的演示截图（接入设置、域名分流、域名详情）。 |
| `data/` | 运行数据与日志，以及生成的 `exports/`、`backup/`。 |

## 修改前核对

1. **控制通道**。Verge 没开启 TCP 控制端口时，枚举 `\\.\pipe\verge-mihomo*` 并优先选择含 `production` 的管道。运行时 YAML 中的管道名可能与实际进程监听的名字不同。
2. **候选成员与预建文件**。注入脚本和安装流程共用显式成员过滤与端口分配。安装和换组需在写入脚本前预建所引用的文件，空文件用 `autoroute-placeholder.invalid` 占位。provider 名带节点标识，避免复用端口时沿用其他出口的规则。运行中的端口、刷新名和文件从 `/rules` 读取的注入规则取得，兼容旧脚本的 `autoroute-p<port>`。
3. **脚本生效判断**。新版脚本记录预建规则文件时的成员集合。集合发生变化时跳过注入，避免订阅更新期间引用尚不存在的规则文件。配置和成员共同决定版本，通过 UDP 兜底组名反映在运行时规则上。就绪还需要首条有效 `MATCH` 指向 AutoRoute。同步 provider 时，内核状态和连接计数继续独立更新。启动时兼容已经加载的旧版脚本，重新写入可获得按版本校验。
4. **重试与并发**。规则写盘成功和 provider 刷新成功分别处理，只有后者完成才缓存同步结果。定时同步重试失败的 provider。异步测速提交前重新确认条目、暂停 / 排除设置及节点映射，避免覆盖用户刚锁定的出口。
5. **SOCKS5 首包**。`socksConnect` 收到上游成功响应后立即暂停读流，交给 Hook 建立双向转发后再恢复，避免丢失响应首包。
6. **本机面板**。面板资源明确列在 `src/panel.js`，脚本和样式使用独立文件。服务端返回的域名、节点、事件和路径按文本渲染，控制器密钥不进入面板 JSON。保留托盘调用的暂停、恢复、批量锁定、导出和退出接口。
7. **验收**。运行 `npm.cmd test`。涉及面板时检查首次接入、待重新应用、规则模式、记录编辑、导出和错误反馈。使用独立目录、端口和演示配置测试安装 / 卸载、运行时规则刷新和截图。

## 变更记录

- **2026-11-18**　首个 GitHub 公开版本，补齐 MIT 许可证和从源码安装的说明，并在「墨间 · Alioth」的开源作品区维护项目入口。本机运行数据和依赖由 `.gitignore` 排除。
- **2026-11-18**　重做域名分流、接入设置和运行事件页面，补齐可视化接入状态、域名详情、操作反馈与使用截图。修复候选变动和端口复用、首条兜底位置、接入版本识别、规则刷新重试、排除域名、首连覆盖手动锁定和导出失效出口的问题。
- **2026-11-18（v0.1.0）**　初版实现命名管道控制、SOCKS5 首连、竞速测速、域名归并、QUIC 回退、本地规则集、Windows 托盘、Web 面板和 YAML 导出。
