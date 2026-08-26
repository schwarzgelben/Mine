/**
 * Surge 策略组全节点 Entry(入口) & Landing(落地) & ASN 链路检测
 * - 支持检测指定策略组下的【所有节点】（自动展开嵌套子策略组）
 * - 精准入口解析：通过 DNS 解析服务器域名，并定向直连查询入口 IP 真实归属地
 * - 精准落地检测：绑定各代理节点（policy）独立探测出口落地 IP、国旗与 AS 归属
 * - 多任务并发与智能排错
 */

(async () => {
  const args = getArgs();
  const targetGroup = args.group || "PROXY";

  try {
    // 1. 获取全量策略组配置信息
    const allGroupsData = await httpApiGet("/v1/policy_groups");
    const allGroupNames = extractGroupNames(allGroupsData);

    // 2. 检查策略组是否存在
    if (!allGroupsData || (!allGroupsData[targetGroup] && !allGroupNames.includes(targetGroup))) {
      // 检查 targetGroup 是否可能直接是一个单独的节点
      const singleDetail = await httpApiGet(`/v1/policies/detail?policy_name=${encodeURIComponent(targetGroup)}`);
      if (!singleDetail || (!singleDetail.type && !singleDetail.server)) {
        const groupTip = allGroupNames.length > 0
          ? `\n\n💡 当前可用策略组:\n${allGroupNames.slice(0, 8).join(", ")}${allGroupNames.length > 8 ? " 等" : ""}`
          : "\n\n💡 请检查 Surge 是否在 [General] 中启用了 http-api";

        $done({
          title: `${targetGroup} 链路检测`,
          content: `❌ 未找到策略组 [${targetGroup}]${groupTip}`,
          icon: "exclamationmark.triangle",
          "icon-color": "#FF3B30"
        });
        return;
      }
    }

    // 3. 获取当前策略组激活/选中的节点
    const activeNodeName = await getActiveNodeForGroup(targetGroup, allGroupsData);

    // 4. 获取该策略组下的所有底层实体节点列表
    let nodeList = await getAllNodesInGroup(targetGroup, allGroupsData);

    // 过滤掉内置无效策略（保留普通代理节点和 DIRECT）
    nodeList = nodeList.filter((name) => {
      const upper = name.toUpperCase();
      return !upper.startsWith("REJECT") && upper !== "PASS";
    });

    if (nodeList.length === 0) {
      $done({
        title: `${targetGroup} 链路检测`,
        content: `策略组 [${targetGroup}] 下未找到可用代理节点`,
        icon: "exclamationmark.triangle",
        "icon-color": "#FF9500"
      });
      return;
    }

    // 5. 并发检测所有节点（限制最大并发数为 4，保证速度且避免冲击 Surge API / 网络）
    const results = await runWithConcurrency(nodeList, async (nodeName) => {
      return await checkSingleNode(nodeName, nodeName === activeNodeName);
    }, 4);

    // 6. 统计检测结果
    const totalCount = results.length;
    const successCount = results.filter((r) => r.landing.success).length;
    const failCount = totalCount - successCount;

    // 7. 构建展示内容
    let content = "";
    if (totalCount === 1) {
      // 单节点精细展示
      const item = results[0];
      const flag = getFlagEmoji(item.landing.countryCode);
      const isActiveText = item.isActive ? " [当前激活]" : "";
      content = [
        `📍 节点: ${flag} ${item.name}${isActiveText} (⚡ ${item.landing.latency})`,
        `🚪 入口: ${item.entry.desc}`,
        `🌍 落地: ${item.landing.ip} ${flag} ${item.landing.location}`,
        `🏢 归属: ${item.landing.asInfo}`
      ].join("\n");
    } else {
      // 多节点列表化展示
      const summaryHeader = `【${targetGroup}】共 ${totalCount} 个节点 (${successCount} 正常${failCount > 0 ? ` / ${failCount} 异常` : ""})\n`;
      const nodeBlocks = results.map((item) => {
        const flag = getFlagEmoji(item.landing.countryCode);
        const activeMark = item.isActive ? "🌟" : "🔹";
        const activeTag = item.isActive ? " [当前]" : "";

        if (item.landing.success) {
          return [
            `${activeMark} ${flag} ${item.name}${activeTag} ⚡ ${item.landing.latency}`,
            `   🚪 入口: ${item.entry.desc}`,
            `   🌍 落地: ${item.landing.ip} ${flag} ${item.landing.location} (${item.landing.asInfo})`
          ].join("\n");
        } else {
          return [
            `❌ ${item.name}${activeTag} (连接失败)`,
            `   🚪 入口: ${item.entry.desc}`,
            `   🌍 落地: 探测超时`
          ].join("\n");
        }
      });

      content = summaryHeader + "\n" + nodeBlocks.join("\n\n");
    }

    // 8. 设置图标状态颜色
    let iconColor = "#34C759"; // 绿色
    if (failCount > 0 && successCount > 0) {
      iconColor = "#FF9500"; // 橙色部分异常
    } else if (successCount === 0) {
      iconColor = "#FF3B30"; // 红色全部失败
    }

    $done({
      title: `${targetGroup} 链路状态 (${successCount}/${totalCount})`,
      content: content,
      icon: "network",
      "icon-color": iconColor
    });
  } catch (err) {
    $done({
      title: `${targetGroup} 检测异常`,
      content: `检测出错: ${err.message || err}`,
      icon: "exclamationmark.triangle",
      "icon-color": "#FF3B30"
    });
  }
})();

/**
 * 检测单个节点的入口与落地信息
 */
async function checkSingleNode(nodeName, isActive = false) {
  // 并行获取该节点的入口服务器信息与落地出口信息
  const [entry, landing] = await Promise.all([
    fetchNodeEntryInfo(nodeName),
    fetchNodeLandingInfo(nodeName)
  ]);

  return {
    name: nodeName,
    isActive,
    entry,
    landing
  };
}

/**
 * 递归展开策略组，获取所有实体代理节点名称
 */
async function getAllNodesInGroup(groupName, allGroupsData, depth = 0) {
  if (depth > 5 || !groupName) return [];
  if (!allGroupsData || !allGroupsData[groupName]) {
    return [groupName];
  }

  const rawList = allGroupsData[groupName];
  if (!Array.isArray(rawList)) return [groupName];

  const result = [];
  for (const item of rawList) {
    const itemName = typeof item === "string" ? item : (item.name || item.policy);
    if (!itemName) continue;

    // 若子项仍为策略组，递归展开
    if (allGroupsData[itemName] && depth < 4) {
      const subNodes = await getAllNodesInGroup(itemName, allGroupsData, depth + 1);
      result.push(...subNodes);
    } else {
      result.push(itemName);
    }
  }

  // 去重并保持顺序
  return Array.from(new Set(result));
}

/**
 * 获取指定策略组当前激活/选中的节点
 */
async function getActiveNodeForGroup(groupName, allGroupsData, depth = 0) {
  if (depth > 5 || !groupName) return null;

  // 1. 尝试 select 策略组接口
  const selectRes = await httpApiGet(`/v1/policy_groups/select?group_name=${encodeURIComponent(groupName)}`);
  if (selectRes && selectRes.policy) {
    const chosen = selectRes.policy;
    if (allGroupsData && allGroupsData[chosen]) {
      return getActiveNodeForGroup(chosen, allGroupsData, depth + 1);
    }
    return chosen;
  }

  // 2. 尝试 test_results 接口 (url-test / fallback / load-balance)
  const testRes = await httpApiGet("/v1/policy_groups/test_results");
  if (testRes && testRes[groupName]) {
    const groupResult = testRes[groupName];
    let winner = null;
    if (typeof groupResult === "string") {
      winner = groupResult;
    } else if (groupResult.winner) {
      winner = typeof groupResult.winner === "string" ? groupResult.winner : groupResult.winner.name;
    } else if (groupResult.policy) {
      winner = groupResult.policy;
    } else if (Array.isArray(groupResult) && groupResult.length > 0) {
      const winnerItem = groupResult.find((i) => i["is-winner"] || i.winner) || groupResult[0];
      winner = winnerItem.name || winnerItem.policy || winnerItem;
    }
    if (winner && typeof winner === "string") {
      if (allGroupsData && allGroupsData[winner]) {
        return getActiveNodeForGroup(winner, allGroupsData, depth + 1);
      }
      return winner;
    }
  }

  // 3. 尝试 policy_groups 默认选中项
  if (allGroupsData && allGroupsData[groupName] && Array.isArray(allGroupsData[groupName])) {
    const list = allGroupsData[groupName];
    const selected = list.find((i) => i["is-selected"] || i.selected || i["is-winner"]);
    const candidate = selected ? (selected.name || selected.policy) : (list[0]?.name || list[0]?.policy);
    if (candidate && typeof candidate === "string") {
      if (allGroupsData[candidate]) {
        return getActiveNodeForGroup(candidate, allGroupsData, depth + 1);
      }
      return candidate;
    }
  }

  return null;
}

/**
 * 内存缓存已解析过的入口 IP 地理位置，避免重复发起 DIRECT 查询
 */
const entryGeoCache = new Map();

/**
 * 获取节点的真实入口信息（通过 policies/detail 获取 server，解析 DNS 并通过 DIRECT 查询入口归属）
 */
async function fetchNodeEntryInfo(policyName) {
  if (!policyName) return { desc: "未知" };

  const upper = policyName.toUpperCase();
  if (upper === "DIRECT" || upper.startsWith("DIRECT-")) {
    return { ip: "直连", desc: "本地网络 (DIRECT)" };
  }

  const detail = await httpApiGet(`/v1/policies/detail?policy_name=${encodeURIComponent(policyName)}`);
  if (!detail || !detail.server) {
    return { ip: "内置/直连", desc: detail?.type || "DIRECT" };
  }

  const serverHost = detail.server;
  const portStr = detail.port ? `:${detail.port}` : "";
  const typeStr = detail.type || "Proxy";

  // 解析入口真实 IP
  let entryIp = null;
  const isDirectIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(serverHost) || serverHost.includes(":");
  if (isDirectIp) {
    entryIp = serverHost;
  } else {
    entryIp = await resolveDomainToIp(serverHost);
  }

  if (!entryIp) {
    // DNS 未能解析出 IP，直接展示域名
    return {
      ip: serverHost,
      desc: `${serverHost}${portStr} (${typeStr})`
    };
  }

  // 查询入口 IP 的地理位置与运营商
  let locDesc = "";
  if (entryGeoCache.has(entryIp)) {
    locDesc = entryGeoCache.get(entryIp);
  } else {
    locDesc = await queryIpLocationDirect(entryIp);
    entryGeoCache.set(entryIp, locDesc);
  }

  const descText = locDesc
    ? `${entryIp}${portStr} (${locDesc})`
    : `${entryIp}${portStr} (${typeStr})`;

  return {
    ip: entryIp,
    desc: descText
  };
}

/**
 * 使用 DIRECT 直连查询入口 IP 的物理位置与运营商
 */
async function queryIpLocationDirect(ip) {
  try {
    const data = await httpRequest({
      url: `http://ip-api.com/json/${encodeURIComponent(ip)}?lang=zh-CN`,
      policy: "DIRECT",
      timeout: 2500
    });
    const res = JSON.parse(data);
    if (res && res.status === "success") {
      const locParts = [res.regionName || res.country, res.city].filter(Boolean);
      let ispText = (res.isp || res.org || "").replace(/China |Telecom|Unicom|Mobile/gi, (m) => {
        if (/telecom/i.test(m)) return "电信";
        if (/unicom/i.test(m)) return "联通";
        if (/mobile/i.test(m)) return "移动";
        return "";
      }).trim();
      if (!ispText && res.as) {
        ispText = res.as.replace(/^AS\d+\s*/i, "").slice(0, 10);
      }
      return `${locParts.join(" ")} ${ispText}`.trim();
    }
  } catch (_) {}
  return "";
}

/**
 * 解析域名对应的 IP (通过直连 DoH / HttpDNS)
 */
async function resolveDomainToIp(domain) {
  if (!domain) return null;

  // 1. 阿里 DNS (DoH via DIRECT)
  try {
    const data = await httpRequest({
      url: `https://dns.alidns.com/resolve?name=${encodeURIComponent(domain)}&type=1`,
      policy: "DIRECT",
      timeout: 2000
    });
    const json = JSON.parse(data);
    if (json && json.Answer && json.Answer.length > 0) {
      const aRecord = json.Answer.find((r) => r.type === 1);
      if (aRecord && aRecord.data) return aRecord.data;
    }
  } catch (_) {}

  // 2. 腾讯 HttpDNS (via DIRECT)
  try {
    const data = await httpRequest({
      url: `http://119.29.29.29/d?dn=${encodeURIComponent(domain)}`,
      policy: "DIRECT",
      timeout: 2000
    });
    if (data && data.includes(".")) {
      const ips = data.split(";").map((i) => i.trim()).filter((ip) => /^(\d{1,3}\.){3}\d{1,3}$/.test(ip));
      if (ips.length > 0) return ips[0];
    }
  } catch (_) {}

  // 3. Cloudflare DoH (via DIRECT)
  try {
    const data = await httpRequest({
      url: `https://1.1.1.1/dns-query?name=${encodeURIComponent(domain)}&type=A`,
      headers: { accept: "application/dns-json" },
      policy: "DIRECT",
      timeout: 2000
    });
    const json = JSON.parse(data);
    if (json && json.Answer && json.Answer.length > 0) {
      const aRecord = json.Answer.find((r) => r.type === 1);
      if (aRecord && aRecord.data) return aRecord.data;
    }
  } catch (_) {}

  return null;
}

/**
 * 精准获取指定节点的落地出口信息（强制通过 policy: nodeName 发送探测请求）
 */
async function fetchNodeLandingInfo(nodeName) {
  const startTime = Date.now();

  // 首选源: ip-api.com (指定 policy 发送)
  try {
    const data = await httpRequest({
      url: "http://ip-api.com/json?lang=zh-CN",
      policy: nodeName,
      timeout: 4000
    });
    const latency = Date.now() - startTime;
    const res = JSON.parse(data);
    if (res && res.status === "success") {
      const locParts = [res.country, res.city].filter(Boolean);
      const asOrg = (res.as || res.org || "").replace(/^AS\d+\s*/i, "").slice(0, 15);
      return {
        success: true,
        ip: res.query || "未知",
        countryCode: res.countryCode || "",
        location: locParts.join(" ") || res.country || "未知",
        asInfo: asOrg || res.as || "-",
        latency: `${latency}ms`
      };
    }
  } catch (_) {}

  // 备选源: api.ip.sb (指定 policy 发送)
  try {
    const data = await httpRequest({
      url: "https://api.ip.sb/geoip",
      headers: { "User-Agent": "Mozilla/5.0" },
      policy: nodeName,
      timeout: 4000
    });
    const latency = Date.now() - startTime;
    const res = JSON.parse(data);
    if (res && res.ip) {
      const locParts = [res.country, res.city].filter(Boolean);
      const asText = res.asn ? `AS${res.asn} ${(res.asn_organization || "").slice(0, 15)}` : (res.organization || "-");
      return {
        success: true,
        ip: res.ip,
        countryCode: res.country_code || "",
        location: locParts.join(" ") || res.country_code || "未知",
        asInfo: asText.trim() || "-",
        latency: `${latency}ms`
      };
    }
  } catch (_) {}

  return {
    success: false,
    ip: "连接超时",
    countryCode: "",
    location: "无法连接",
    asInfo: "-",
    latency: "超时"
  };
}

/**
 * 并发控制执行器
 */
async function runWithConcurrency(items, fn, limit = 4) {
  const results = new Array(items.length);
  let currentIndex = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (currentIndex < items.length) {
      const idx = currentIndex++;
      results[idx] = await fn(items[idx], idx);
    }
  });

  await Promise.all(workers);
  return results;
}

/**
 * 提取全量策略组名称列表
 */
function extractGroupNames(allGroupsData) {
  if (!allGroupsData) return [];
  if (Array.isArray(allGroupsData["policy-groups"])) {
    return allGroupsData["policy-groups"];
  }
  return Object.keys(allGroupsData).filter((k) => k !== "policy-groups" && Array.isArray(allGroupsData[k]));
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