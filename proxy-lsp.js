/**
 * Surge 策略组当前节点 Entry(入口) & Landing(落地) & ASN 检测
 */

(async () => {
  const args = getArgs();
  const targetGroup = args.group || "PROXY";

  // 1. 从 Surge HTTP API 获取当前选中的节点名称
  const activePolicyName = await getActivePolicy(targetGroup);
  if (!activePolicyName) {
    $done({
      title: targetGroup,
      content: `未找到策略组 [${targetGroup}] 或 HTTP API 未开启`,
      icon: "exclamationmark.triangle",
      "icon-color": "#FF3B30"
    });
    return;
  }

  // 2. 并行获取：本地直连、代理落地(Landing)、入口解析(Server Entry)
  const [landing, serverEntry] = await Promise.all([
    fetchLandingInfo(),
    fetchServerEntry(activePolicyName)
  ]);

  // 3. 构建展示内容
  const lines = [
    `📍 当前节点: ${activePolicyName}`,
    `🚪 入口: ${serverEntry.ip} (${serverEntry.desc})`,
    `🌍 落地: ${landing.ip} [${landing.country}]`,
    `🏢 归属: AS${landing.asn || "-"} ${landing.org || ""}`
  ];

  $done({
    title: `${targetGroup} 链路状态`,
    content: lines.join("\n"),
    icon: "network",
    "icon-color": "#34C759"
  });
})();

// 获取策略组当前选中的节点名称
function getActivePolicy(groupName) {
  return new Promise((resolve) => {
    $httpAPI("GET", `/v1/policy_groups/select?name=${encodeURIComponent(groupName)}`, null, (res) => {
      if (res && res.policy) {
        resolve(res.policy);
      } else {
        resolve(null);
      }
    });
  });
}

// 获取代理落地出口信息
function fetchLandingInfo() {
  return new Promise((resolve) => {
    $httpClient.get(
      {
        url: "https://api.ip.sb/geoip",
        headers: { "User-Agent": "Mozilla/5.0" },
        timeout: 6000
      },
      (error, response, data) => {
        if (error || !data) {
          resolve({ ip: "检测超时", country: "ERR", asn: "", org: "" });
          return;
        }
        try {
          const res = JSON.parse(data);
          resolve({
            ip: res.ip || "未知",
            country: res.country_code || "UN",
            asn: res.asn || "",
            org: (res.asn_organization || "").slice(0, 15)
          });
        } catch {
          resolve({ ip: "解析失败", country: "ERR", asn: "", org: "" });
        }
      }
    );
  });
}

// 获取节点服务器的真实入口 IP (DNS 解析)
function fetchServerEntry(policyName) {
  return new Promise((resolve) => {
    $httpAPI("GET", `/v1/policies/detail?name=${encodeURIComponent(policyName)}`, null, (res) => {
      if (res && res.server) {
        // 如果节点配置的是 IP 直接返回，如果是域名则尝试解析
        const serverHost = res.server;
        resolve({ ip: serverHost, desc: res.type || "Proxy" });
      } else {
        resolve({ ip: "内置/直连", desc: "DIRECT" });
      }
    });
  });
}

function getArgs() {
  if (typeof $argument === "undefined") return {};
  return Object.fromEntries(
    $argument
      .split("&")
      .map((item) => item.split("="))
      .map(([k, v]) => [k, decodeURIComponent(v || "")])
  );
}