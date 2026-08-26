# Surge 策略组链路检测面板 (Proxy LSP)

实时检测 Surge 策略组当前激活节点的入口服务器、落地出口 IP、地理位置与 ASN 归属信息。

## 功能特性

- 🎯 **自动穿透多层嵌套**：支持 `select`、`url-test`、`fallback`、`load-balance` 等策略组类型，自动穿透嵌套策略组找到真实的代理节点。
- 🚪 **入口与类型展示**：显示节点的真实入口服务器域名/IP、端口及协议类型（Trojan、Shadowsocks、VMess 等）。
- 🌍 **落地与地理位置**：多数据源高可用查询（ip-api.com / ip.sb / ipwho.is），展示国旗 Emoji、城市与 AS 组织。
- 💡 **智能排错诊断**：当策略组名称填写错误或未找到时，自动在面板中列出 Surge 当前所有可用的策略组名称。

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
3. 保存并刷新面板即可查看链路检测结果。
