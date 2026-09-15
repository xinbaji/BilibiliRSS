# BilibiliRSS 安全审计报告

| 项目 | 内容 |
|---|---|
| 审计对象 | BilibiliRSS.user.js v0.3.0（`@version 0.3.0`，217,521 字节 / 4,040 行，commit `c573a91`） |
| 审计日期 | 2026-09-15 |
| 审计方式 | 人工逐点审查 + 脚本化静态扫描（凭据读写 / 动态执行 / 消息面 / DOM 注入点 / 请求目标 / 存储解析 / 日志输出） |
| 结论 | **整体安全状况良好，无 Critical 级问题。1 项中危（供应链加固建议）、3 项低危、2 项提示级。已核实多项关键安全面达标。** |

---

## 一、信任边界与攻击面概览

脚本运行于 Tampermonkey 沙箱，注入 `www.bilibili.com` 与 `space.bilibili.com`。攻击面：

1. **数据入口**：B 站 API 响应（标题、UP 名、封面 URL 等 —— 视为不可信输入）
2. **代码入口**：ffmpeg 引擎文件从第三方 CDN 下载后在页面主世界执行
3. **用户入口**：备份 JSON 文件导入
4. **持久化**：GM_setValue 本地存储 + IndexedDB 引擎缓存
5. **外发通道**：GM_xmlhttpRequest / fetch / GM_download / window.open

---

## 二、已核实达标的安全面

### ✅ 无动态代码执行（除引擎加载，见发现 1）
全文件 **0 处** `eval` / `new Function`；无 `data:text/html`、无 `javascript:` URL、无 postMessage 监听。

### ✅ XSS 面收敛
- `esc()`（L45）完整转义 `& < > " '`；`attr()`（L1940）双重引号防护；`cssUrl()`（L1939）转义 `'` 和 `\`。定义正确。
- 27 处 `innerHTML` 赋值点逐一核对（含两轮独立审查交叉验证）：B 站 API 返回的番剧名 / 集名 / UP 名 / 简介等字符串在 HTML 拼接处均经 `esc()`，属性位均经 `attr()` / `encodeURIComponent`；列表渲染大量使用 `textContent`。
- 订阅 / 监控 / 下载页卡片构建器中 `esc`/`attr` 合计调用 56 次，密度与 API 字符串插值点匹配。
- `background-image` 均通过 `el.style.backgroundImage` 属性赋值（非 attribute 解析上下文），配合 `cssUrl()` 转义，无法逃逸出 CSS 值执行脚本。

### ✅ 凭据处理（v0.3.0 已收敛）
- **不读取、不存储任何凭据**：SESSDATA 为 HttpOnly，脚本从不读取；`bili_jct` 全项目零引用。
- 下载请求 URL 不再携带 `session` 参数（v0.3.0 修复），登录态完全依赖浏览器对 `api.bilibili.com` 自动携带的 Cookie。
- 日志检查：console 输出中无 store / cookie / 凭据内容（唯一一处 `console.error('[BRLRSS] save', e)` 不含数据体）。

### ✅ 请求目标严格收敛
所有外发请求目标均落在 `@connect` 白名单（11 个域，全部为 B 站系与图床/视频 CDN）；`build/header_check.js` 质量门持续校验白名单与实际请求点一致。**无任何第三方统计、上报或自定义服务器。**

### ✅ 本地存储无敏感数据
GM_setValue 写入 4 处：主 store（订阅/列表/监控/设置/下载队列）、主题偏好、头像 dataURL 缓存（≤400 张，单张 ≤400KB）。无凭据、无浏览历史明文外泄面。数据清除入口（设置 → 清空）同时删除主 store 与头像缓存。

### ✅ 原型污染免疫
存储恢复与备份导入均使用对象展开语法（L154、L2833），`CreateDataProperty` 语义下 JSON 中的 `__proto__` 键不会触发原型链 setter。存储字段加载后有严格的数组/对象类型纠正（L156-166）。

### ✅ 下载文件名安全
`sanitizeName`（L69）替换 Windows 非法字符（含 `\` / `/`，**阻断路径穿越**）、剥离视频扩展名、限长 80 字符。弹幕 / 封面文件名由同一 sanitize 产物派生。

### ✅ window.open 固定域前缀
仅 2 处（L3017-3018），均为 `https://www.bilibili.com/...` 固定前缀 + 数值型 epId/pid，无法跳转外域。

### ✅ iframe / 嵌入面为零
脚本不创建 iframe、不被嵌入场景利用（Shadow DOM 隔离 UI）。

---

## 三、发现与建议

### 发现 1（中危）：ffmpeg 引擎供应链缺完整性校验

**位置**：L1080-1084（CDN 列表）、L1211-1227（下载与缓存）、L1261-1274（blob 注入主世界执行）

**描述**：ffmpeg.wasm 引擎（ffmpeg.js / core.wasm 等 4 个文件）从 npmmirror / jsdelivr / unpkg 三个第三方 CDN 下载后，以 `blob:` URL 注入 `<script>` 在页面**主世界**执行。当前**没有对文件内容做哈希校验** —— 任一 CDN 被投毒或返回篡改内容，即获得 bilibili 页面主世界的代码执行能力（可访问用户 B 站会话）。

**缓解现状**：CDN URL **版本锁定**（`@ffmpeg/ffmpeg@0.12.15` / `@ffmpeg/core@0.12.10`，不可变地址，非 latest 漂移）；全部 HTTPS；首次下载后 IndexedDB 持久缓存不再联网；仅在高画质合并时才加载。

**建议（按成本排序）**：
1. **预置哈希校验（推荐）**：对 4 个文件的当前官方版本预计算 SHA-256 写入脚本，`ffAsset` 下载后校验，不匹配则记为失败换下一个 CDN，全部不匹配则报错回落直链下载。一次性工作，彻底消除投毒面。
2. 或改从脚本作者自己的 GitHub Release 附件分发引擎文件（消除第三方 CDN 信任）。

### 发现 2（低危）：buvid 指纹 Cookie 回写

**位置**：L232-247

**描述**：脚本调用 B 站官方 `x/frontend/finger/spi` 接口获取 `buvid3/buvid4`，并以 `Domain=.bilibili.com; SameSite=None; Secure` 写回用户浏览器 Cookie（仅在该 Cookie 缺失时补写，6 小时节流）。值**来自 B 站本身**，属于设备指纹「补全」而非伪造，目的是规避 API 412 风控。

**风险**：cookie 写入仅限 B 站自己的域，无跨站泄露；但它在用户无感知的情况下修改了 B 站站点 Cookie 状态。

**建议**：可接受。若求极简可在文档中向用户披露此行为（README 隐私小节已提及数据行为，可补一句）。保留现状亦可。

### 发现 3（低危）：`warmAva` 回填 URL 未走 `cssUrl()` 转义

**位置**：L1971、L1985

**描述**：`el.style.backgroundImage = "url('" + (data || url) + "')"` 中 `url` 来自 API 的头像地址，未经过 `cssUrl()` 的引号转义。含 `'` 的恶意值可注入 CSS 值片段。**影响有限**：CSS 属性值注入在现代浏览器无法执行 JS，且作用域仅限 Shadow DOM 内单元素样式；`data`（dataURL 形态）分支无此问题。

**建议**：两处改用现成的 `cssUrl()` 包裹，1 行改动。随下个版本修复。

### 发现 4（低危）：备份导入缺少 schema 校验

**位置**：L2824-2840

**描述**：导入 JSON 仅检查「是对象」，未像启动加载那样做字段类型纠正。畸形备份（如 `subs: 42`）会导致渲染层 `forEach` 异常、面板显示异常。**不构成注入面**（展开语法无原型污染，字符串仍走转义），属健壮性问题 —— 触发者只能是用户自己选择了坏文件。

**建议**：导入后复用 `loadStore()` 的类型纠正逻辑（或导入走同一 normalize 函数）。

### 提示级（无需处理）

- **弹幕下载走 `GM_download(data:text/xml;...)`**（L1741）：内容来自 `comment.bilibili.com` 的公开弹幕 XML，保存为 `.xml` 文件，无 HTML/脚本执行面。
- **头像 dataURL 未校验 MIME**（L1996）：`Blob` 无 type，浏览器按 `application/octet-stream` 生成 dataURL，仅用作图片背景，无执行面。

---

## 四、渗透面排查记录（供复核）

| 排查项 | 结果 |
|---|---|
| `eval` / `new Function` / `setTimeout(字符串)` | 0 处 |
| `document.cookie` 读取 | 0 处（仅写 buvid，见发现 2） |
| `document.cookie` 写入 | 2 处，域限定 `.bilibili.com`，值源自 B 站官方接口 |
| `unsafeWindow` 使用 | 1 处目的：读取主世界 ffmpeg 引擎实例，未暴露沙箱敏感面 |
| `postMessage` / message 监听 | 0 处 |
| 外发请求域名 | 全部 ∈ `@connect` 白名单（质量门自动校验） |
| innerHTML 注入点 | 27 处，逐点核对转义覆盖 |
| `JSON.parse` 入口 | 6 处：本地存储 ×2、API 响应 ×3、用户导入 ×1（展开语法均无原型污染） |
| GM_download 文件名 | 统一经 `sanitizeName`，无路径穿越 |
| 日志泄漏 | 无凭据 / 数据体输出 |
| 依赖 | 零 npm 依赖；Bootstrap Icons 为内联 SVG 字符串；md5 为内置实现 |

---

## 五、结论

v0.3.0 的安全设计总体到位：**最小权限 header、零第三方上报、凭据零接触、XSS 面系统化转义、文件名净化、无动态执行**（引擎加载除外）。唯一值得尽快处理的是**发现 1 的引擎哈希校验** —— 这是当前唯一可能被第三方触达代码执行路径的环节；其余 3 项均为低成本健壮性修补。

建议节奏：
1. **v0.3.1**：修复发现 3、4（共 ~5 行）+ 发现 1 的哈希校验（~30 行）；
2. **文档**：README 隐私小节补充 buvid cookie 行为披露（发现 2）。
