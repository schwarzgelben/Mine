(async () => {
  const args = getArgs();
  const targetGroup = args.group || "PROXY";

  // 1. 获取所有策略组详情
  const groupData = await httpGetJson("/v1/policy_groups");
  
  if (!groupData) {
    $done({
      title: `${targetGroup} 检测失败`,
      content: "请确认已在 [General] 开启 http-api-web-dashboard = true",
      icon: "exclamationmark.triangle",
      "icon-color": "#FF3B30"
    });
    return;
  }

  const allGroups = groupData["policy-groups"] || groupData;
  const targetList = allGroups[targetGroup];

  if (!targetList || targetList.length === 0) {
    $done({
      title: targetGroup,
      content: `未找到策略组 [${targetGroup}]，请检查参数设置`,
      icon: "questionmark.circle",
      "icon-color": "#FF9500"
    });
    return;
  }

  // 提取有效节点名
  const policyNames = targetList
    .map((item) => (typeof item === "string" ? item : item.name))
    .filter((name) => name && name !== "DIRECT" && name !== "REJECT");

  // 2. 限制并发数分批执行（每批 4 个）
  const results = [];
  const batchSize = 4;
  for (let i = 0; i < policyNames.length; i += batchSize) {
    const batch = policyNames.slice(i, i + batchSize);
    const batchRes = await Promise.all(batch.map((name) => probeExit(name)));
    results.push(...batchRes);
  }

  // 3. 格式化面板输出：节点名 -> 落地IP [国家] AS编号 组织简写
  const content = results
    .map((r) => {
      if (r.error) {
        return `${r.name}: ${r.ip}`;
      }
      const asnStr = r.asn ? ` AS${r.asn}` : "";
      const orgStr = r.org ? ` ${r.org}` : "";
      return `${r.name}:\n  └ ${r.ip} [${r.country}]${asnStr}${orgStr}`;
    })
    .join("\n");

  $done({
    title: `${targetGroup} 检测 (${results.length}个)`,
    content: content || "未检测到有效节点",
    icon: "network",
    "icon-color": "#34C759"
  });
})();

// 通过指定 policy 请求接口获取 IP、国家、ASN 及 ISP 信息
function probeExit(policyName) {
  return new Promise((resolve) => {
    $httpClient.get(
      {
        url: "https://ipwho.is/",
        headers: {
          "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)"
        },
        policy: policyName,
        timeout: 6000
      },
      (error, response, data) => {
        if (error || !data) {
          resolve({ name: policyName, ip: "连接超时/失败", error: true });
          return;
        }

        try {
          const res = JSON.parse(data);
          if (res.success === false) {
            resolve({ name: policyName, ip: "查询受限", error: true });
          } else {
            resolve({
              name: policyName,
              ip: res.ip || "未知",
              country: res.country_code || "UN",
              asn: res.connection ? res.connection.asn : "",
              // 截短过长的组织名称，防止面板被换行撑破
              org: res.connection && res.connection.org ? res.connection.org.slice(0, 15) : ""
            });
          }
        } catch {
          resolve({ name: policyName, ip: "解析异常", error: true });
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