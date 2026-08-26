/**
 * Surge 策略组子节点落地、国家与 ASN 检测（高可用版）
 */

(async () => {
  const args = getArgs();
  const targetGroup = args.group || "PROXY";

  console.log(`[Proxy-Checker] 开始检测策略组: ${targetGroup}`);

  // 1. 获取所有策略组详情
  const groupData = await httpGetJson("/v1/policy_groups");
  
  if (!groupData) {
    console.log("[Proxy-Checker] 无法连接 Surge HTTP API");
    $done({
      title: `${targetGroup} 检测失败`,
      content: "请确认已开启 http-api-web-dashboard = true",
      icon: "exclamationmark.triangle",
      "icon-color": "#FF3B30"
    });
    return;
  }

  const allGroups = groupData["policy-groups"] || groupData;
  const targetList = allGroups[targetGroup];

  if (!targetList || targetList.length === 0) {
    console.log(`[Proxy-Checker] 未找到策略组: ${targetGroup}`);
    $done({
      title: targetGroup,
      content: `未找到策略组 [${targetGroup}]，请检查参数设置`,
      icon: "questionmark.circle",
      "icon-color": "#FF9500"
    });
    return;
  }

  // 提取有效节点名（过滤 DIRECT、REJECT 及内置策略）
  const policyNames = targetList
    .map((item) => (typeof item === "string" ? item : item.name))
    .filter((name) => name && name !== "DIRECT" && name !== "REJECT" && !name.startsWith("SYSTEM"));

  console.log(`[Proxy-Checker] 获取到 ${policyNames.length} 个子节点，开始探测...`);

  // 2. 分批并发探测（每批 3 个节点，防止堵塞网络通道）
  const results = [];
  const batchSize = 3;
  for (let i = 0; i < policyNames.length; i += batchSize) {
    const batch = policyNames.slice(i, i + batchSize);
    const batchRes = await Promise.all(batch.map((name) => probeNode(name)));
    results.push(...batchRes);
  }

  // 3. 格式化面板输出
  const content = results
    .map((r) => {
      if (r.error) {
        return `${r.name}:\n  └ ⚠️ ${r.msg}`;
      }
      const asnStr = r.asn ? ` AS${r.asn}` : "";
      const orgStr = r.org ? ` ${r.org}` : "";
      return `${r.name}:\n  └ ${r.ip} [${r.country}]${asnStr}${orgStr}`;
    })
    .join("\n");

  $done({
    title: `${targetGroup} 落地检测 (${results.length}个)`,
    content: content || "未检测到有效节点",
    icon: "network",
    "icon-color": "#34C759"
  });
})();

// 节点探测函数（ip.sb 主测 + Cloudflare 兜底）
async function probeNode(policyName) {
  // 方案 1: api.ip.sb
  try {
    const info = await fetchIpSb(policyName);
    if (info && info.ip) return { name: policyName, ...info };
  } catch (e) {
    console.log(`[Proxy-Checker] [${policyName}] ip.sb 失败: ${e.message || e}`);
  }

  // 方案 2: cloudflare.com/cdn-cgi/trace 兜底
  try {
    const cfInfo = await fetchCfTrace(policyName);
    if (cfInfo && cfInfo.ip) return { name: policyName, ...cfInfo };
  } catch (e) {
    console.log(`[Proxy-Checker] [${policyName}] Cloudflare 兜底失败: ${e.message || e}`);
  }

  return { name: policyName, error: true, msg: "连接失败/不可达" };
}

// 1. IP.SB 接口
function fetchIpSb(policyName) {
  return new Promise((resolve, reject) => {
    $httpClient.get(
      {
        url: "https://api.ip.sb/geoip",
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"
        },
        policy: policyName,
        timeout: 5000
      },
      (error, response, data) => {
        if (error || !data) {
          return reject(error || "No response");
        }
        try {
          const res = JSON.parse(data);
          resolve({
            ip: res.ip,
            country: res.country_code || "UN",
            asn: res.asn || "",
            org: (res.asn_organization || "").slice(0, 15)
          });
        } catch (err) {
          reject(err);
        }
      }
    );
  });
}

// 2. Cloudflare Trace 接口
function fetchCfTrace(policyName) {
  return new Promise((resolve, reject) => {
    $httpClient.get(
      {
        url: "https://cloudflare.com/cdn-cgi/trace",
        policy: policyName,
        timeout: 5000
      },
      (error, response, data) => {
        if (error || !data) {
          return reject(error || "No response");
        }
        try {
          const lines = data.split("\n");
          const map = {};
          lines.forEach((line) => {
            const [k, v] = line.split("=");
            if (k && v) map[k.trim()] = v.trim();
          });
          if (map.ip) {
            resolve({
              ip: map.ip,
              country: map.loc || "UN",
              asn: "",
              org: `CF-${map.colo || ""}`
            });
          } else {
            reject("Parse failed");
          }
        } catch (err) {
          reject(err);
        }
      }
    );
  });
}

function httpGetJson(path) {
  return new Promise((resolve) => {
    $httpAPI("GET", path, null, (result) => {
      resolve(result);
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