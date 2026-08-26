# Surge 策略组全节点链路检测面板 (Proxy LSP)

实时检测 Surge 策略组下**所有节点**的入口服务器归属、落地出口 IP、地理位置、国旗与 ASN 归属信息。

## 功能特性

- 🚀 **检测全量节点**：自动展开并检测指定策略组下的所有实体代理节点，并高亮标记当前激活节点（`🌟 [当前]`）。
- 🚪 **精准入口解析**：通过直连 DoH / HttpDNS 解析节点服务器的真实 IP，并查询入口服务器的地理位置与运营商（如 `120.232.x.x (广东广州 移动)`）。
- 🌍 **精准落地检测**：通过 Surge 的 `policy: nodeName` 针对每个节点独立发起探测，准确获取该节点的落地出口 IP、地理位置与 AS 归属（如 `104.28.x.x 🇭🇰 (Cloudflare)`）。
- ⚡ **并发加速**：内置多任务并发控制池（限制并发），保证多节点快速出结果的同时不造成卡顿。
- 💡 **智能排错诊断**：若策略组名称不存在，自动列出当前所有可用策略组供参考校对。

## 前置要求

使用该脚本需要开启 Surge 的 **HTTP API** 功能。请在 Surge 配置文件的 `[General]` 段落添加：

```ini
[General]
http-api = yourpassword@0.0.0.0:6171
http-api-tls = false
```

## 安装与使用

1. 在 Surge 中导入模块 `proxy-checker.sgmodule`：
   - 模块地址：`https://raw.githubusercontent.com/schwarzgelben/Mine/main/proxy-checker.sgmodule`
2. 在模块参数设置中，将 `group` 修改为你需要检测的策略组名称（默认为 `PROXY`，例如：`节点选择`、`Auto`、`PROXY` 等）。
3. 保存并在面板中点击刷新即可开始全节点链路检测。
