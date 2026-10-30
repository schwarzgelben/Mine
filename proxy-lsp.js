/*
 * Surge Proxy LSP
 * Entry / Landing / Connectivity
 *
 * 参数：
 * group=PROXY
 * landing=current | all | off
 * max=0
 *
 * landing:
 * current = 检测当前策略组出口
 * all     = 逐个检测所有节点出口
 * off     = 关闭出口检测
 *
 * max:
 * 0 = 显示全部节点
 * 正整数 = 限制显示数量，不影响实际检测
 *
 * 需要 Surge HTTP API
 */

const SETTINGS = {
  testURL: "http://cp.cloudflare.com/generate_204",
  geoURL: "https://api.ip.sb/geoip",
  geoFallbackURL: "https://ipwho.is/",
  dohURL: "https://cloudflare-dns.com/dns-query",

  httpTimeout: 4,
  dnsTimeout: 2.5,

  batchSize: 12,
  apiConcurrency: 2,
  nodeConcurrency: 5,
  landingConcurrency: 3
};

(async () => {
  try {
    const args = readArgs();

    const group = args.group || "PROXY";

    const landingMode = ["current", "all", "off"].includes(args.landing)
      ? args.landing
      : "current";

    const displayMax = Math.max(
      0,
      parseInt(args.max || "0", 10) || 0
    );

    // 1. 获取策略与策略组
    let [policyResponse, groupResponse] = await Promise.all([
      api("GET", "/v1/policies", {
        include_external: true
      }),
      api("GET", "/v1/policy_groups")
    ]);

    // 兼容旧版 Surge
    if (!policyResponse || !Array.isArray(policyResponse.proxies)) {
      policyResponse = await api("GET", "/v1/policies");
    }

    if (
      !policyResponse ||
      (
        !Array.isArray(policyResponse.proxies) &&
        !Array.isArray(policyResponse["policy-groups"])
      )
    ) {
      throw new Error(
        "无法读取 /v1/policies，请检查 Surge HTTP API 是否启用"
      );
    }

    const localNames = new Set(
      policyResponse.proxies || []
    );

    const groups = normalizeGroups(groupResponse);

    for (const name of policyResponse["policy-groups"] || []) {
      if (typeof name === "string" && !groups.has(name)) {
        groups.set(name, null);
      }
    }

    // 2. 获取 select 策略组信息
    const selects =
      typeof $surge !== "undefined" &&
      $surge.selectGroupDetails
        ? $surge.selectGroupDetails()
        : null;

    const decisions =
      selects && selects.decisions
        ? selects.decisions
        : {};

    if (selects && selects.groups) {
      for (const [name, members] of Object.entries(selects.groups)) {
        if (!groups.has(name) || !groups.get(name)?.length) {
          groups.set(name, normalizeMembers(members));
        }
      }
    }

    // 3. 外部订阅策略
    const externals = Array.isArray(
      policyResponse["external-policies"]
    )
      ? policyResponse["external-policies"].filter(
          x => x && x.name && x.identifier && x.group
        )
      : [];

    const warnings = new Set();

    // 4. 展开策略组
    const nodes = collectNodes(
      group,
      groups,
      localNames,
      externals,
      warnings
    );

    // 5. 解析当前选择
    const selected = resolveSelected(
      group,
      groups,
      decisions
    );

    // DIRECT 特殊处理
    if (
      nodes.length === 0 &&
      (group === "DIRECT" || selected === "DIRECT")
    ) {
      const direct =
        landingMode === "off"
          ? null
          : await getLanding("DIRECT");

      finish(
        "DIRECT · 直连出口",
        landingMode === "off"
          ? "直连模式（已关闭出口检测）"
          : "本次直连出口：" + formatLanding(direct),
        "info"
      );

      return;
    }

    if (nodes.length === 0) {
      const known = [...groups.keys()];

      const reason = known.includes(group)
        ? "策略组成员为空或当前版本 API 未提供可展开的成员"
        : `未找到策略组或节点「${group}」`;

      finish(
        group + " 链路检测",
        reason +
          (
            known.length
              ? "\n可用策略组：" + known.slice(0, 8).join("、")
              : ""
          ),
        "error"
      );

      return;
    }

    // 6. 确定当前选中节点
    const selectedId = selected
      ? nodes.find(
          n => n.id === selected || n.name === selected
        )?.id
      : null;

    // 7. 并行检测
    const [entries, tests, landings] = await Promise.all([
      mapLimit(
        nodes,
        SETTINGS.nodeConcurrency,
        node => getEntry(node)
      ),

      testNodes(nodes),

      landingMode === "all"
        ? mapLimit(
            nodes,
            SETTINGS.landingConcurrency,
            node => getLanding(node.id)
          )
        : landingMode === "current"
          ? getLanding(group)
          : Promise.resolve(null)
    ]);

    // 8. 整理结果
    const rows = nodes.map((node, index) => ({
      ...node,

      entry: entries[index],

      test:
        tests.get(node.id) ||
        { status: "unknown" },

      landing:
        landingMode === "all"
          ? landings[index]
          : null,

      selected: selectedId === node.id
    }));

    const ok = rows.filter(
      r => r.test.status === "ok"
    ).length;

    const bad = rows.filter(
      r => r.test.status === "fail"
    ).length;

    const unknown = rows.length - ok - bad;

    const summary =
      `${rows.length} 节点 | ${ok} 连通 | ${bad} 失败` +
      (unknown ? ` | ${unknown} 未知` : "");

    const lines = [summary];

    if (selected) {
      lines.push(`当前选择：${selected}`);
    } else if (groups.has(group)) {
      lines.push("当前节点：动态策略 / 无法唯一确定");
    }

    if (landingMode === "current") {
      lines.push(
        "本次组出口：" + formatLanding(landings)
      );

      lines.push(
        "（出口仅对应本次按该策略发起的请求）"
      );
    }

    if (warnings.size) {
      lines.push(
        "注意：" +
        [...warnings].slice(0, 2).join("；")
      );
    }

    lines.push("");

    // 9. 面板输出
    const visible = displayMax
      ? rows.slice(0, displayMax)
      : rows;

    for (const row of visible) {
      const icon =
        row.test.status === "ok"
          ? "✅"
          : row.test.status === "fail"
            ? "❌"
            : "❔";

      const active = row.selected
        ? " ★已选择"
        : "";

      const stat =
        row.test.status === "ok"
          ? `${row.test.ms}ms`
          : row.test.status === "fail"
            ? (row.test.reason || "失败")
            : "未测明";

      lines.push(
        `${icon} ${row.name}${active} · ${stat}`
      );

      lines.push(
        "  入口：" + row.entry
      );

      if (landingMode === "all") {
        lines.push(
          "  落地：" + formatLanding(row.landing)
        );
      }
    }

    if (visible.length < rows.length) {
      lines.push(
        `…还有 ${rows.length - visible.length} 个节点未显示（均已检测）`
      );
    }

    console.log("LSP summary: " + summary);

    finish(
      `${group} · ${ok}/${rows.length} 连通`,
      lines.join("\n"),
      bad
        ? (ok ? "alert" : "error")
        : unknown
          ? "info"
          : "good"
    );

  } catch (error) {
    console.log(
      "LSP ERROR: " + (error.stack || error)
    );

    finish(
      "Proxy LSP 检测失败",
      String(error.message || error),
      "error"
    );
  }
})();


// ========================================
// 面板输出
// ========================================

function finish(title, content, style) {
  $done({
    title,
    content,
    style
  });
}


// ========================================
// 参数解析
// ========================================

function readArgs() {
  const raw =
    typeof $argument === "string"
      ? $argument.trim()
      : "";

  if (!raw) {
    return {
      group: "PROXY",
      landing: "current"
    };
  }

  if (!raw.includes("=")) {
    return {
      group: raw,
      landing: "current"
    };
  }

  const args = {};

  for (const part of raw.split("&")) {
    const i = part.indexOf("=");

    if (i < 0) continue;

    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();

    try {
      args[key] = decodeURIComponent(
        value.replace(/\+/g, " ")
      );
    } catch (_) {
      args[key] = value;
    }
  }

  return args;
}


// ========================================
// Surge HTTP API
// ========================================

function api(method, path, params = {}) {
  return new Promise(resolve => {
    try {
      $httpAPI(
        method,
        path,
        params,
        res => resolve(res || null)
      );
    } catch (e) {
      console.log(`API ${path}: ${e}`);
      resolve(null);
    }
  });
}


// ========================================
// HTTP 请求
// ========================================

function http(options) {
  return new Promise((resolve, reject) => {
    $httpClient.get(
      options,
      (error, response, data) => {
        if (error) {
          return reject(
            new Error(String(error))
          );
        }

        if (
          !response ||
          response.status < 200 ||
          response.status >= 300
        ) {
          return reject(
            new Error(
              "HTTP " + (response?.status ?? "未知")
            )
          );
        }

        resolve({
          data,
          status: response.status
        });
      }
    );
  });
}


// ========================================
// 策略组数据规范化
// ========================================

function normalizeMembers(list) {
  if (!Array.isArray(list)) return null;

  return list
    .map(item =>
      typeof item === "string"
        ? item
        : item && (
            item.name ||
            item.policy ||
            item.identifier
          )
    )
    .filter(
      x => typeof x === "string" && x
    );
}


function normalizeGroups(res) {
  const groups = new Map();

  if (!res || typeof res !== "object") {
    return groups;
  }

  const ingest = (name, value) => {
    const members = normalizeMembers(
      Array.isArray(value)
        ? value
        : value && (
            value.options ||
            value.policies ||
            value.members ||
            value.proxies ||
            value["policy-group"]
          )
    );

    if (name && typeof name === "string") {
      groups.set(name, members);
    }
  };

  const list =
    res["policy-groups"] ||
    res.groups;

  if (Array.isArray(list)) {
    for (const item of list) {
      if (typeof item === "string") {
        ingest(item, null);
      } else if (item && item.name) {
        ingest(item.name, item);
      }
    }
  } else if (
    list &&
    typeof list === "object"
  ) {
    for (const [name, value] of Object.entries(list)) {
      ingest(name, value);
    }
  }

  // 兼容部分版本的直接映射结构
  for (const [name, value] of Object.entries(res)) {
    if (
      [
        "groups",
        "policy-groups",
        "error",
        "success",
        "time"
      ].includes(name)
    ) {
      continue;
    }

    if (
      Array.isArray(value) ||
      (
        value &&
        typeof value === "object" &&
        (
          Array.isArray(value.options) ||
          Array.isArray(value.policies) ||
          Array.isArray(value.members)
        )
      )
    ) {
      ingest(name, value);
    }
  }

  return groups;
}


// ========================================
// 递归展开策略组
// ========================================

function collectNodes(
  group,
  groups,
  locals,
  externals,
  warnings
) {
  const result = new Map();
  const visiting = new Set();
  const groupExternal = new Map();

  for (const e of externals) {
    if (!groupExternal.has(e.group)) {
      groupExternal.set(e.group, []);
    }

    groupExternal.get(e.group).push(e);
  }

  const add = node => {
    if (!result.has(node.id)) {
      result.set(node.id, node);
    }
  };

  const visit = (name, owner = null) => {
    if (isBuiltIn(name)) return;

    if (!groups.has(name)) {
      const matches = (
        groupExternal.get(owner) || []
      ).filter(
        e =>
          e.name === name ||
          e.identifier === name
      );

      if (matches.length) {
        for (const e of matches) {
          add({
            id: e.identifier,
            name: e.name,
            external: true
          });
        }
      } else if (locals.has(name)) {
        add({
          id: name,
          name,
          external: false
        });
      } else {
        warnings.add(
          "无法识别成员 " + name
        );
      }

      return;
    }

    if (visiting.has(name)) {
      warnings.add(
        "策略组存在循环引用：" + name
      );
      return;
    }

    const members = groups.get(name);

    if (
      !members &&
      !(groupExternal.get(name) || []).length
    ) {
      warnings.add(
        "无法展开策略组 " + name
      );
      return;
    }

    visiting.add(name);

    for (const member of members || []) {
      visit(member, name);
    }

    for (const e of groupExternal.get(name) || []) {
      add({
        id: e.identifier,
        name: e.name,
        external: true
      });
    }

    visiting.delete(name);
  };

  if (groups.has(group)) {
    visit(group);
  } else if (!isBuiltIn(group)) {
    visit(group);
  }

  return [...result.values()];
}


function isBuiltIn(name) {
  return /^(DIRECT|PASS|REJECT(?:-.+)?|COMPATIBLE)$/i.test(
    name || ""
  );
}


// ========================================
// 当前选择解析
// ========================================

function resolveSelected(
  name,
  groups,
  decisions
) {
  const seen = new Set();

  while (groups.has(name)) {
    if (seen.has(name)) return null;

    seen.add(name);

    const selected = decisions[name];

    if (
      typeof selected !== "string" ||
      !selected
    ) {
      return null;
    }

    name = selected;
  }

  return name;
}


// ========================================
// 并发控制
// ========================================

async function mapLimit(items, limit, worker) {
  const output = new Array(items.length);
  let cursor = 0;

  const runners = Array.from(
    {
      length: Math.min(limit, items.length)
    },
    async () => {
      while (cursor < items.length) {
        const index = cursor++;

        try {
          output[index] = await worker(
            items[index],
            index
          );
        } catch (e) {
          output[index] = null;
          console.log("Task: " + e);
        }
      }
    }
  );

  await Promise.all(runners);

  return output;
}


// ========================================
// 节点入口信息
// ========================================

const dnsCache = new Map();


async function getEntry(node) {
  const detail = await api(
    "GET",
    "/v1/policies/detail",
    {
      policy_name: node.id
    }
  );

  if (
    !detail ||
    typeof detail.server !== "string" ||
    !detail.server
  ) {
    return node.external
      ? "外部节点（配置入口不可读）"
      : "节点配置不可读";
  }

  const host = detail.server.replace(
    /^\[|\]$/g,
    ""
  );

  const port = detail.port
    ? ":" + detail.port
    : "";

  const type = detail.type
    ? ` [${detail.type}]`
    : "";

  const ip = isIP(host)
    ? host
    : await resolveDNS(host);

  if (!ip) {
    return `${host}${port}${type}（DNS 未解析，非实际第一跳）`;
  }

  const geo = localGeo(ip);

  const domainInfo =
    host !== ip
      ? `${host} → `
      : "";

  return (
    `${domainInfo}${ip}${port}${type} ${geo}` +
    `（${host !== ip ? "DNS参考" : "配置IP"}）`
  );
}


function isIP(input) {
  if (typeof input !== "string") {
    return false;
  }

  if (input.includes(":")) {
    return /^[0-9a-f:.%]+$/i.test(input);
  }

  const parts = input.split(".");

  return (
    parts.length === 4 &&
    parts.every(
      p =>
        /^\d{1,3}$/.test(p) &&
        +p <= 255
    )
  );
}


// ========================================
// DNS 解析
// ========================================

function resolveDNS(host) {
  if (!dnsCache.has(host)) {
    dnsCache.set(
      host,
      queryDNS(host)
    );
  }

  return dnsCache.get(host);
}


async function queryDNS(host) {
  // 独立 DIRECT 查询，不冒充 Surge 实际连接 IP
  for (const type of ["A", "AAAA"]) {
    try {
      const url =
        `${SETTINGS.dohURL}` +
        `?name=${encodeURIComponent(host)}` +
        `&type=${type}`;

      const response = await http({
        url,

        headers: {
          Accept: "application/dns-json"
        },

        policy: "DIRECT",
        timeout: SETTINGS.dnsTimeout
      });

      const body = JSON.parse(response.data);

      const answer = (body.Answer || []).find(
        a =>
          a &&
          a.type === (
            type === "A" ? 1 : 28
          ) &&
          isIP(a.data)
      );

      if (answer) {
        return answer.data;
      }

    } catch (_) {
      // 查询失败继续尝试下一种地址类型
    }
  }

  return null;
}


// ========================================
// Surge 原生 GeoIP / ASN
// ========================================

function localGeo(ip) {
  try {
    const country = $utils.geoip(ip) || "";
    const asn = $utils.ipasn(ip);
    const org = $utils.ipaso(ip) || "";

    const parts = [
      flag(country) + (country || "未知地区")
    ];

    if (asn) {
      parts.push(
        "AS" + String(asn).replace(/^AS/i, "")
      );
    }

    if (org) {
      parts.push(
        String(org).slice(0, 32)
      );
    }

    return parts.join(" ");

  } catch (_) {
    return "归属未知";
  }
}


function flag(code) {
  if (!/^[A-Za-z]{2}$/.test(code || "")) {
    return "🌐";
  }

  return String.fromCodePoint(
    ...[...code.toUpperCase()].map(
      c => c.charCodeAt(0) + 127397
    )
  );
}


// ========================================
// 全节点连通性检测
// ========================================

async function testNodes(nodes) {
  const results = new Map();

  const native = nodes.filter(
    node => !node.external
  );

  const batches = [];

  for (
    let i = 0;
    i < native.length;
    i += SETTINGS.batchSize
  ) {
    batches.push(
      native.slice(
        i,
        i + SETTINGS.batchSize
      )
    );
  }

  // 优先使用 Surge 原生测速
  await mapLimit(
    batches,
    SETTINGS.apiConcurrency,
    async batch => {
      const response = await api(
        "POST",
        "/v1/policies/test",
        {
          policy_names: batch.map(
            node => node.id
          ),

          url: SETTINGS.testURL
        }
      );

      for (const node of batch) {
        const measurement = findTestValue(
          response,
          node.id
        );

        if (measurement) {
          results.set(
            node.id,
            measurement
          );
        }
      }
    }
  );

  // 对无法识别的结果进行绑定策略的 HTTP 检测
  const missing = nodes.filter(
    node => !results.has(node.id)
  );

  const fallback = await mapLimit(
    missing,
    SETTINGS.nodeConcurrency,
    testByHTTP
  );

  missing.forEach((node, i) => {
    results.set(
      node.id,
      fallback[i] || {
        status: "unknown"
      }
    );
  });

  return results;
}


// ========================================
// 解析测速结果
// ========================================

function findTestValue(response, name) {
  if (
    !response ||
    typeof response !== "object"
  ) {
    return null;
  }

  const containers = [response];

  if (response.data) {
    containers.push(response.data);
  }

  if (
    response.results &&
    !Array.isArray(response.results)
  ) {
    containers.push(response.results);
  }

  if (Array.isArray(response.results)) {
    for (const entry of response.results) {
      if (entry && typeof entry === "object") {
        containers.push(entry);

        if (entry.data) {
          containers.push(entry.data);
        }
      }
    }
  }

  for (const container of containers) {
    if (
      !container ||
      typeof container !== "object"
    ) {
      continue;
    }

    const raw = container[name];

    if (raw === undefined) {
      continue;
    }

    if (
      raw === -1 ||
      raw === null ||
      raw === false
    ) {
      return {
        status: "fail",
        reason: "超时"
      };
    }

    if (
      typeof raw === "number" &&
      Number.isFinite(raw) &&
      raw > 0
    ) {
      return {
        status: "ok",
        ms: Math.round(raw)
      };
    }

    if (
      raw &&
      typeof raw === "object"
    ) {
      if (
        raw.error ||
        raw.success === false
      ) {
        return {
          status: "fail",
          reason: "测试失败"
        };
      }

      const ms = [
        raw.available,
        raw.latency,
        raw.delay,
        raw.http
      ].find(
        x =>
          typeof x === "number" &&
          Number.isFinite(x) &&
          x > 0
      );

      if (ms !== undefined) {
        return {
          status: "ok",
          ms: Math.round(ms)
        };
      }
    }
  }

  return null;
}


// ========================================
// 单节点 HTTP 连通性回退检测
// ========================================

async function testByHTTP(node) {
  const begin = Date.now();

  try {
    const response = await http({
      url: SETTINGS.testURL,

      policy: node.id,

      timeout: SETTINGS.httpTimeout,

      "auto-redirect": false
    });

    if (response.status !== 204) {
      return {
        status: "fail",
        reason: "HTTP " + response.status
      };
    }

    return {
      status: "ok",
      ms: Math.max(
        1,
        Date.now() - begin
      )
    };

  } catch (e) {
    return {
      status: "fail",
      reason: String(
        e.message || e
      ).slice(0, 24)
    };
  }
}


// ========================================
// 落地出口 IP 检测
// ========================================

async function getLanding(policy) {
  if (
    isBuiltIn(policy) &&
    policy !== "DIRECT"
  ) {
    return null;
  }

  const endpoints = [
    SETTINGS.geoURL,
    SETTINGS.geoFallbackURL
  ];

  for (const url of endpoints) {
    try {
      const response = await http({
        url,

        policy,

        timeout: SETTINGS.httpTimeout,

        headers: {
          Accept: "application/json",
          "User-Agent": "Surge-Proxy-LSP/1.0"
        }
      });

      const json = JSON.parse(response.data);

      if (
        json.success === false ||
        !json.ip ||
        !isIP(json.ip)
      ) {
        continue;
      }

      const country =
        json.country_code ||
        json.countryCode ||
        "";

      const city = json.city || "";

      const org =
        json.connection?.org ||
        json.connection?.isp ||
        json.asn_organization ||
        "";

      const asn =
        json.connection?.asn ||
        json.asn;

      const base = localGeo(json.ip);

      return {
        ip: json.ip,

        info: base,

        city: city
          ? String(city).slice(0, 28)
          : "",

        remoteASN: asn
          ? "AS" + String(asn).replace(/^AS/i, "")
          : "",

        remoteOrg: String(org || "").slice(0, 28),

        country
      };

    } catch (_) {
      // 使用备用查询服务，但保持同一策略
    }
  }

  return null;
}


// ========================================
// 落地信息格式化
// ========================================

function formatLanding(landing) {
  if (!landing) {
    return "查询失败 / 超时";
  }

  const parts = [
    landing.ip,
    landing.info
  ];

  if (landing.city) {
    parts.push(landing.city);
  }

  if (
    !/\bAS\d+\b/.test(landing.info) &&
    landing.remoteASN
  ) {
    parts.push(landing.remoteASN);
  }

  if (
    landing.remoteOrg &&
    !landing.info.includes(landing.remoteOrg)
  ) {
    parts.push(landing.remoteOrg);
  }

  return parts.join(" · ");
}
