/**
 * Surge 策略组当前节点 Entry(入口) & Landing(落地) & ASN 链路检测
 * 支持多层嵌套策略组 (select / url-test / fallback / load-balance) 自动递归穿透解析
 */

(async () => {
  const args = getArgs();
  const targetGroup = args.group || "PROXY";

  try {
    // 1. 递归解析策略组当前激活的实际节点
    const resolved = await resolveActivePolicy(targetGroup);

    if (!resolved || !resolved.finalNode) {
      // 尝试获取当前所有策略组列表以提供精准提示
      const allGroups = await getAllPolicyGroupNames();
      const groupTip = allGroups.length > 0
        ? `\n\n💡 可用策略组:\n${allGroups.slice(0, 8).join(", ")}${allGroups.length > 8 ? " 等" : ""}`
        : "\n\n💡 请检查 Surge 是否在 [General] 中启用了 http-api";

      $done({
        title: `${targetGroup} 链路状态`,
        content: `❌ 未找到策略组 [${targetGroup}]${groupTip}`,
        icon: "exclamationmark.triangle",
        "icon-color": "#FF3B30"
      });
      return;
    }

    const { finalNode, chain } = resolved;

    // 2. 并行获取：代理落地(Landing)信息、入口服务器解析(Server Entry)
    const [landing, serverEntry] = await Promise.all([
      fetchLandingInfo(),
      fetchServerEntry(finalNode)
    ]);

    // 3. 构建展示标题与内容
    const flag = getFlagEmoji(landing.countryCode);
    const chainDesc = chain.length > 1 ? ` (${chain.slice(1).join(" → ")})` : "";

    const lines = [
      `📍 节点: ${flag} ${finalNode}${chainDesc}`,
      `🚪 入口: ${serverEntry.desc}`,
      `🌍 落地: ${landing.ip} ${flag} ${landing.location}`,
      `🏢 归属: ${landing.asInfo}`
    ];

    $done({
      title: `${targetGroup} 链路状态`,
      content: lines.join("\n"),
      icon: "network",
      "icon-color": "#34C759"
    });
  } catch (err) {
    $done({
      title: `${targetGroup} 检测异常`,
      content: `检测出错: ${err.message || err}`,
      icon: "exclamationmark.triangle",
      "icon-color": "#FF9500"
    });
  }
})();

/**
 * 递归解析策略组，支持多层嵌套 (如 PROXY -> Auto -> 香港 01)
 */
async function resolveActivePolicy(name, depth = 0, chain = []) {
  if (depth > 6 || !name) return null;
  const currentChain = [...chain, name];

  // 1. 尝试直接作为 select 策略组查询
  const selectRes = await httpApiGet(`/v1/policy_groups/select?group_name=${encodeURIComponent(name)}`);
  if (selectRes && selectRes.policy) {
    const nextPolicy = selectRes.policy;
    // 递归检查该选中的 policy 是否仍是一个策略组
    const deeper = await resolveActivePolicy(nextPolicy, depth + 1, currentChain);
    if (deeper) return deeper;
    return { finalNode: nextPolicy, chain: currentChain };
  }

  // 2. 尝试从 test_results 查询 (url-test / fallback / load-balance 策略组)
  const testRes = await httpApiGet("/v1/policy_groups/test_results");
  if (testRes && testRes[name]) {
    const groupResult = testRes[name];
    let winner = null;
    if (typeof groupResult === "string") {
      winner = groupResult;
    } else if (groupResult.winner) {
      winner = typeof groupResult.winner === "string" ? groupResult.winner : groupResult.winner.name;
    } else if (groupResult.policy) {
      winner = groupResult.policy;
    } else if (Array.isArray(groupResult) && groupResult.length > 0) {
      const winnerItem = groupResult.find((item) => item["is-winner"] || item.winner) || groupResult[0];
      winner = winnerItem.name || winnerItem.policy || winnerItem;
    }

    if (winner && typeof winner === "string") {
      const deeper = await resolveActivePolicy(winner, depth + 1, currentChain);
      if (deeper) return deeper;
      return { finalNode: winner, chain: currentChain };
    }
  }

  // 3. 尝试从全量 policy_groups 中查找当前选中的选项
  const allGroups = await httpApiGet("/v1/policy_groups");
  if (allGroups && allGroups[name] && Array.isArray(allGroups[name])) {
    const list = allGroups[name];
    const selected = list.find((item) => item["is-selected"] || item.selected || item["is-winner"]);
    const candidate = selected ? (selected.name || selected.policy) : (list[0]?.name || list[0]?.policy || list[0]);
    if (candidate && typeof candidate === "string") {
      const deeper = await resolveActivePolicy(candidate, depth + 1, currentChain);
      if (deeper) return deeper;
      return { finalNode: candidate, chain: currentChain };
    }
  }

  // 4. 检查它是否本身就是一个实体节点或内置策略
  const detailRes = await httpApiGet(`/v1/policies/detail?policy_name=${encodeURIComponent(name)}`);
  if (detailRes && (detailRes.type || detailRes.server || name.toUpperCase() === "DIRECT" || name.toUpperCase() === "REJECT")) {
    return { finalNode: name, chain: chain.length > 0 ? chain : [name] };
  }

  return null;
}

/**
 * 获取所有策略组名称列表 (用于未找到时的友好提示)
 */
async function getAllPolicyGroupNames() {
  try {
    const res = await httpApiGet("/v1/policy_groups");
    if (!res) return [];
    if (Array.isArray(res["policy-groups"])) {
      return res["policy-groups"];
    }
    return Object.keys(res).filter((k) => k !== "policy-groups" && Array.isArray(res[k]));
  } catch {
    return [];
  }
}

/**
 * 获取节点真实入口服务器信息
 */
async function fetchServerEntry(policyName) {
  if (!policyName) return { desc: "未知" };

  const upper = policyName.toUpperCase();
  if (upper === "DIRECT" || upper.startsWith("DIRECT-")) {
    return { desc: "直连 (DIRECT)" };
  }
  if (upper === "REJECT" || upper.startsWith("REJECT-")) {
    return { desc: "拒绝连接 (REJECT)" };
  }

  const detail = await httpApiGet(`/v1/policies/detail?policy_name=${encodeURIComponent(policyName)}`);
  if (!detail) {
    return { desc: "内置/直连" };
  }

  const type = detail.type || "Proxy";
  const server = detail.server || "";
  const port = detail.port ? `:${detail.port}` : "";

  if (server) {
    return { desc: `${server}${port} (${type})` };
  }

  return { desc: `${type}` };
}

/**
 * 获取落地出口 IP 与地理位置信息
 */
async function fetchLandingInfo() {
  // 首选 ip-api.com (支持中文城市和详细 ASN)
  try {
    const data = await httpRequest({
      url: "http://ip-api.com/json?lang=zh-CN",
      timeout: 5000
    });
    const res = JSON.parse(data);
    if (res && res.status === "success") {
      const locParts = [res.country, res.city].filter(Boolean);
      return {
        ip: res.query || "未知",
        countryCode: res.countryCode || "",
        location: locParts.join(" ") || "未知位置",
        asInfo: res.as || res.org || res.isp || "-"
      };
    }
  } catch (_) {
    // 降级使用备用源
  }

  // 备用源 1: api.ip.sb
  try {
    const data = await httpRequest({
      url: "https://api.ip.sb/geoip",
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 5000
    });
    const res = JSON.parse(data);
    if (res && res.ip) {
      const locParts = [res.country, res.city].filter(Boolean);
      const asText = res.asn ? `AS${res.asn} ${res.asn_organization || ""}` : (res.organization || "-");
      return {
        ip: res.ip,
        countryCode: res.country_code || "",
        location: locParts.join(" ") || res.country_code || "未知位置",
        asInfo: asText.trim() || "-"
      };
    }
  } catch (_) {}

  // 备用源 2: ipwho.is
  try {
    const data = await httpRequest({
      url: "https://ipwho.is/?lang=zh-CN",
      timeout: 5000
    });
    const res = JSON.parse(data);
    if (res && res.success) {
      const locParts = [res.country, res.city].filter(Boolean);
      const asText = res.connection?.asn ? `AS${res.connection.asn} ${res.connection.org || ""}` : (res.connection?.isp || "-");
      return {
        ip: res.ip,
        countryCode: res.country_code || "",
        location: locParts.join(" ") || "未知位置",
        asInfo: asText.trim() || "-"
      };
    }
  } catch (_) {}

  return {
    ip: "检测超时",
    countryCode: "",
    location: "网络连接失败",
    asInfo: "-"
  };
}

/**
 * 封装 Surge $httpAPI GET 请求
 */
function httpApiGet(path) {
  return new Promise((resolve) => {
    $httpAPI("GET", path, null, (res) => {
      resolve(res || null);
    });
  });
}

/**
 * 封装 Surge $httpClient GET 请求
 */
function httpRequest(options) {
  return new Promise((resolve, reject) => {
    $httpClient.get(options, (error, response, data) => {
      if (error) {
        reject(error);
      } else {
        resolve(data);
      }
    });
  });
}

/**
 * 国家二字码转换为国旗 Emoji
 */
function getFlagEmoji(countryCode) {
  if (!countryCode || countryCode.length !== 2) return "🌐";
  const codePoints = countryCode
    .toUpperCase()
    .split("")
    .map((char) => 127397 + char.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
}

/**
 * 解析 Surge 传入的 argument 参数
 */
function getArgs() {
  if (typeof $argument === "undefined" || !$argument) return { group: "PROXY" };
  const raw = $argument.trim();
  if (!raw.includes("=")) {
    return { group: raw };
  }
  const params = {};
  raw.split("&").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx !== -1) {
      const k = pair.slice(0, idx).trim();
      const v = pair.slice(idx + 1).trim();
      params[k] = decodeURIComponent(v);
    }
  });
  return params;
}