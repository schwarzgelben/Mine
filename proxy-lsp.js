/**
 * Surge 策略组全节点 Entry(入口) & Landing(落地) & 连通性检测 (Proxy LSP)
 * 
 * 核心优化：
 * 1. 规范适配 Surge $httpAPI 参数传递规范 (通过 body/query 对象传递)
 * 2. 增强策略组与节点层级递归展开逻辑
 * 3. 采用 Surge 原生 /v1/policies/test 进行真实代理链路测速与存活探测
 * 4. 直连解析节点入口 IP、地理位置与运营商归属 (阿里 DoH / 腾讯 HttpDNS / IP 地理库)
 * 5. 精准探测当前激活节点的真实落地出口 IP、地理位置与 ASN
 */

(async () => {
  const args = getArgs();
  const targetGroup = args.group || "PROXY";

  try {
    // 1. 获取全量策略组信息
    const allGroupsRes = await httpApiRequest("GET", "v1/policy_groups");
    const allGroupNames = extractGroupNames(allGroupsRes);

    // 2. 检查策略组是否存在
    const groupExists = allGroupNames.includes(targetGroup) || (allGroupsRes && allGroupsRes[targetGroup]);
    
    // 如果不是策略组，尝试检查是否为单个独立节点
    if (!groupExists) {
      const singleDetail = await httpApiRequest("GET", "v1/policies/detail", { policy_name: targetGroup });
      if (!singleDetail || (!singleDetail.type && !singleDetail.server)) {
        const groupTip = allGroupNames.length > 0
          ? `\n\n💡 可用策略组:\n${allGroupNames.slice(0, 8).join(", ")}${allGroupNames.length > 8 ? " 等" : ""}`
          : "\n\n💡 请检查 Surge [General] 中是否启用了 http-api";

        $done({
          title: `${targetGroup} 链路检测`,
          content: `❌ 未找到策略组 [${targetGroup}]${groupTip}`,
          icon: "exclamationmark.triangle",
          "icon-color": "#FF3B30"
        });
        return;
      }
    }

    // 3. 获取当前策略组激活节点
    const activeNodeName = await getActiveNode(targetGroup, allGroupsRes);

    // 4. 递归展开策略组获取所有实体节点
    let rawNodeList = await getAllNodes(targetGroup, allGroupsRes);
    
    // 过滤掉 DIRECT、REJECT、PASS 等内置策略
    const nodeList = rawNodeList.filter((name) => {
      const upper = name.toUpperCase();
      return !upper.startsWith("REJECT") && upper !== "PASS" && upper !== "DIRECT";
    });

    if (nodeList.length === 0) {
      // 若只包含 DIRECT 或为空
      if (rawNodeList.includes("DIRECT") || targetGroup.toUpperCase() === "DIRECT") {
        const activeLanding = await fetchLandingInfo();
        $done({
          title: `${targetGroup} 直连链路`,
          content: `📍 节点: DIRECT (直连)\n🌍 落地: ${activeLanding.ip} ${getFlagEmoji(activeLanding.countryCode)} ${activeLanding.location} (${activeLanding.asInfo})`,
          icon: "network",
          "icon-color": "#34C759"
        });
        return;
      }

      $done({
        title: `${targetGroup} 链路检测`,
        content: `策略组 [${targetGroup}] 下未找到可用代理节点`,
        icon: "exclamationmark.triangle",
        "icon-color": "#FF9500"
      });
      return;
    }

    // 5. 并行：
    //    A. 获取所有节点的入口详情（Server 域名/IP、端口、类型）并直连查询入口 IP 运营商
    //    B. 通过 Surge 官方 /v1/policies/test 测速真实代理连通性
    //    C. 获取当前激活节点的真实落地出口 IP 与 ASN
    const [entryList, latencyMap, activeLanding] = await Promise.all([
      runWithConcurrency(nodeList, (name) => fetchNodeEntryInfo(name), 5),
      testPoliciesLatency(nodeList),
      fetchLandingInfo()
    ]);

    // 6. 整合组装结果
    const results = nodeList.map((name, index) => {
      const entry = entryList[index];
      const latency = latencyMap[name];
      const isActive = name === activeNodeName;
      const isAlive = typeof latency === "number" && latency > 0;

      return {
        name,
        isActive,
        isAlive,
        latency: isAlive ? `${Math.round(latency * 1000)}ms` : (latency === -1 ? "超时" : "未测"),
        entry,
        landing: isActive ? activeLanding : null
      };
    });

    const totalCount = results.length;
    const successCount = results.filter((r) => r.isAlive).length;
    const failCount = totalCount - successCount;

    // 7. 生成格式化面板内容
    let content = "";
    if (totalCount === 1) {
      const item = results[0];
      const flag = getFlagEmoji(activeLanding.countryCode);
      content = [
        `📍 节点: ${item.name} (⚡ ${item.latency})`,
        `🚪 入口: ${item.entry.desc}`,
        `🌍 落地: ${activeLanding.ip} ${flag} ${activeLanding.location}`,
        `🏢 归属: ${activeLanding.asInfo}`
      ].join("\n");
    } else {
      const summaryHeader = `【${targetGroup}】共 ${totalCount} 个节点 (${successCount} 连通${failCount > 0 ? ` / ${failCount} 异常` : ""})\n`;
      const nodeBlocks = results.map((item) => {
        const activeMark = item.isActive ? "🌟" : "🔹";
        const activeTag = item.isActive ? " [当前]" : "";

        if (item.isActive && activeLanding.success) {
          const flag = getFlagEmoji(activeLanding.countryCode);
          return [
            `${activeMark} ${flag} ${item.name}${activeTag} ⚡ ${item.latency}`,
            `   🚪 入口: ${item.entry.desc}`,
            `   🌍 落地: ${activeLanding.ip} ${flag} ${activeLanding.location} (${activeLanding.asInfo})`
          ].join("\n");
        } else if (item.isAlive) {
          return [
            `${activeMark} ${item.name}${activeTag} ⚡ ${item.latency}`,
            `   🚪 入口: ${item.entry.desc}`
          ].join("\n");
        } else {
          return [
            `❌ ${item.name}${activeTag} (连接失败 / ${item.latency})`,
            `   🚪 入口: ${item.entry.desc}`
          ].join("\n");
        }
      });

      content = summaryHeader + "\n" + nodeBlocks.join("\n\n");
    }

    // 8. 图标颜色判断
    let iconColor = "#34C759";
    if (failCount > 0 && successCount > 0) {
      iconColor = "#FF9500";
    } else if (successCount === 0 && totalCount > 0) {
      iconColor = "#FF3B30";
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
 * 递归获取策略组下的所有实体代理节点
 */
async function getAllNodes(groupName, allGroupsRes, depth = 0) {
  if (depth > 5 || !groupName) return [groupName];

  // 1. 从 policy_groups 返回列表中查找
  let groupObj = null;
  if (allGroupsRes) {
    if (Array.isArray(allGroupsRes["policy-groups"])) {
      groupObj = allGroupsRes["policy-groups"].find((g) => (g.name || g) === groupName);
    } else if (Array.isArray(allGroupsRes[groupName])) {
      groupObj = { options: allGroupsRes[groupName] };
    }
  }

  // 2. 如果未找到，尝试从单个 policy_group 接口获取
  let options = [];
  if (groupObj && Array.isArray(groupObj.options)) {
    options = groupObj.options;
  } else if (groupObj && Array.isArray(groupObj)) {
    options = groupObj;
  } else {
    const singleRes = await httpApiRequest("GET", "v1/policy_groups/select", { group_name: groupName });
    if (singleRes && Array.isArray(singleRes["policy-group"])) {
      options = singleRes["policy-group"];
    } else if (singleRes && Array.isArray(singleRes.options)) {
      options = singleRes.options;
    }
  }

  if (options.length === 0) {
    return [groupName];
  }

  const result = [];
  for (const opt of options) {
    const optName = typeof opt === "string" ? opt : (opt.name || opt.policy);
    if (!optName) continue;

    // 检查是否为嵌套策略组
    const isSubGroup = allGroupsRes && (
      (Array.isArray(allGroupsRes["policy-groups"]) && allGroupsRes["policy-groups"].some(g => (g.name || g) === optName)) ||
      Array.isArray(allGroupsRes[optName])
    );

    if (isSubGroup && depth < 4) {
      const subNodes = await getAllNodes(optName, allGroupsRes, depth + 1);
      result.push(...subNodes);
    } else {
      result.push(optName);
    }
  }

  return Array.from(new Set(result));
}

/**
 * 获取策略组当前选中的激活节点
 */
async function getActiveNode(groupName, allGroupsRes, depth = 0) {
  if (depth > 5 || !groupName) return groupName;

  // 1. 尝试 /v1/policy_groups/select 查询
  const selectRes = await httpApiRequest("GET", "v1/policy_groups/select", { group_name: groupName });
  if (selectRes && selectRes.policy) {
    return await getActiveNode(selectRes.policy, allGroupsRes, depth + 1);
  }

  // 2. 尝试 /v1/policy_groups/test_results 查询
  const testRes = await httpApiRequest("GET", "v1/policy_groups/test_results");
  if (testRes && testRes[groupName]) {
    const item = testRes[groupName];
    const winner = typeof item === "string" ? item : (item.winner || item.policy || item["is-winner"]);
    if (winner && typeof winner === "string") {
      return await getActiveNode(winner, allGroupsRes, depth + 1);
    }
  }

  return groupName;
}

/**
 * 获取节点配置详情及入口 IP / 运营商归属
 */
const entryGeoCache = new Map();

async function fetchNodeEntryInfo(policyName) {
  if (!policyName) return { desc: "未知" };

  try {
    const detail = await httpApiRequest("GET", "v1/policies/detail", { policy_name: policyName });
    if (!detail || !detail.server) {
      return { ip: "-", desc: detail?.type || "DIRECT" };
    }

    const serverHost = detail.server;
    const portStr = detail.port ? `:${detail.port}` : "";
    const typeStr = detail.type || "Proxy";

    // 判断是否直接是 IP
    let entryIp = null;
    const isIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(serverHost) || serverHost.includes(":");
    if (isIp) {
      entryIp = serverHost;
    } else {
      entryIp = await resolveDomainToIp(serverHost);
    }

    if (!entryIp) {
      return {
        ip: serverHost,
        desc: `${serverHost}${portStr} (${typeStr})`
      };
    }

    let locDesc = "";
    if (entryGeoCache.has(entryIp)) {
      locDesc = entryGeoCache.get(entryIp);
    } else {
      locDesc = await queryIpLocationDirect(entryIp);
      entryGeoCache.set(entryIp, locDesc);
    }

    return {
      ip: entryIp,
      desc: locDesc ? `${entryIp}${portStr} (${locDesc})` : `${entryIp}${portStr} (${typeStr})`
    };
  } catch (_) {
    return { ip: "-", desc: "获取失败" };
  }
}

/**
 * 官方接口批量测速 (/v1/policies/test)
 */
async function testPoliciesLatency(nodeList) {
  const latencyMap = {};
  if (!nodeList || nodeList.length === 0) return latencyMap;

  try {
    const res = await httpApiRequest("POST", "v1/policies/test", {
      policy_names: nodeList,
      url: "http://cp.cloudflare.com/generate_204"
    });

    if (res) {
      // Surge 返回格式通常为 { "NodeA": 0.123, "NodeB": -1 } 或数组对象
      if (typeof res === "object") {
        for (const [key, val] of Object.entries(res)) {
          if (typeof val === "number") {
            latencyMap[key] = val;
          } else if (val && typeof val.tcp === "number") {
            latencyMap[key] = val.tcp;
          } else if (val && typeof val.rtt === "number") {
            latencyMap[key] = val.rtt;
          }
        }
      }
    }
  } catch (_) {}

  return latencyMap;
}

/**
 * 获取当前全局/激活策略的真实落地出口 IP 与地理位置
 */
async function fetchLandingInfo() {
  const startTime = Date.now();

  // 1. 尝试 ipwho.is
  try {
    const data = await httpRequest({
      url: "https://ipwho.is/",
      timeout: 3500
    });
    const latency = Date.now() - startTime;
    const res = JSON.parse(data);
    if (res && res.success !== false && res.ip) {
      const locParts = [res.country, res.city].filter(Boolean);
      const asOrg = (res.connection?.org || res.connection?.isp || res.connection?.asn || "").toString().slice(0, 16);
      return {
        success: true,
        ip: res.ip,
        countryCode: res.country_code || "",
        location: locParts.join(" ") || res.country || "未知",
        asInfo: asOrg || "-",
        latency: `${latency}ms`
      };
    }
  } catch (_) {}

  // 2. 尝试 api.ip.sb
  try {
    const data = await httpRequest({
      url: "https://api.ip.sb/geoip",
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 3500
    });
    const latency = Date.now() - startTime;
    const res = JSON.parse(data);
    if (res && res.ip) {
      const locParts = [res.country, res.city].filter(Boolean);
      const asText = res.asn ? `AS${res.asn} ${(res.asn_organization || "").slice(0, 12)}` : (res.organization || "-");
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

  // 3. 尝试 myip.la
  try {
    const data = await httpRequest({
      url: "https://api.myip.la/cn?json",
      timeout: 3000
    });
    const latency = Date.now() - startTime;
    const res = JSON.parse(data);
    if (res && res.ip) {
      const locParts = [res.location?.country_name, res.location?.city].filter(Boolean);
      return {
        success: true,
        ip: res.ip,
        countryCode: res.location?.country_code || "",
        location: locParts.join(" ") || "未知",
        asInfo: res.location?.asn || "-",
        latency: `${latency}ms`
      };
    }
  } catch (_) {}

  return {
    success: false,
    ip: "获取超时",
    countryCode: "",
    location: "未知",
    asInfo: "-",
    latency: "超时"
  };
}

/**
 * 直连 DoH / HttpDNS 解析域名
 */
async function resolveDomainToIp(domain) {
  if (!domain) return null;

  // 阿里 DoH
  try {
    const data = await httpRequest({
      url: `https://dns.alidns.com/resolve?name=${encodeURIComponent(domain)}&type=1`,
      timeout: 2000
    });
    const json = JSON.parse(data);
    if (json && json.Answer && json.Answer.length > 0) {
      const aRecord = json.Answer.find((r) => r.type === 1);
      if (aRecord && aRecord.data) return aRecord.data;
    }
  } catch (_) {}

  // 腾讯 HttpDNS
  try {
    const data = await httpRequest({
      url: `http://119.29.29.29/d?dn=${encodeURIComponent(domain)}`,
      timeout: 2000
    });
    if (data && data.includes(".")) {
      const ips = data.split(";").map((i) => i.trim()).filter((ip) => /^(\d{1,3}\.){3}\d{1,3}$/.test(ip));
      if (ips.length > 0) return ips[0];
    }
  } catch (_) {}

  return null;
}

/**
 * 查询 IP 的地理位置与运营商归属
 */
async function queryIpLocationDirect(ip) {
  try {
    const data = await httpRequest({
      url: `https://qifu-api.baidubce.com/ip/geo/v1/district?ip=${encodeURIComponent(ip)}`,
      timeout: 2000
    });
    const res = JSON.parse(data);
    if (res && res.code === "Success" && res.data) {
      const d = res.data;
      const loc = [d.prov, d.city].filter(Boolean).join(" ") || d.country;
      const isp = d.isp || "";
      return `${loc} ${isp}`.trim();
    }
  } catch (_) {}

  try {
    const data = await httpRequest({
      url: `https://api.vore.top/api/IPdata?ip=${encodeURIComponent(ip)}`,
      timeout: 2000
    });
    const res = JSON.parse(data);
    if (res && res.code === 200 && res.ipdata) {
      const info = res.ipdata.info1 || res.ipdata.info2 || "";
      const isp = res.ipdata.isp || "";
      return `${info} ${isp}`.trim();
    }
  } catch (_) {}

  return "";
}

/**
 * 提取全量策略组名称
 */
function extractGroupNames(res) {
  if (!res) return [];
  if (Array.isArray(res["policy-groups"])) {
    return res["policy-groups"].map((g) => (typeof g === "string" ? g : g.name)).filter(Boolean);
  }
  return Object.keys(res).filter((k) => k !== "policy-groups" && Array.isArray(res[k]));
}

/**
 * 封装 Surge $httpAPI
 */
function httpApiRequest(method, path, body = null) {
  return new Promise((resolve) => {
    // 确保 path 不带前导斜杠
    const cleanPath = path.startsWith("/") ? path.slice(1) : path;
    $httpAPI(method, cleanPath, body, (res) => {
      resolve(res || null);
    });
  });
}

/**
 * 封装 Surge $httpClient GET
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
 * 国家代码转国旗 Emoji
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
 * 解析参数
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