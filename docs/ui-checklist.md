# UI/UX 审计清单

基线：dsh-usage `1.1.0` 修改前 → 当前工作区（未发版）。
范围：悬浮卡（收起/展开）、详情弹窗、热力图、余额行、空态与占位符、键盘可达性。

状态：`✅ 已修` / `🟡 待定` / `⬜ 未动`。

## 一、空态与占位规范（结论）

曾经同时存在 `0`、`–`（en dash）、`—`（em dash）、`…` 四种占位，语义重叠。

规则：

| 状态 | 符号 | 例子 |
| :--- | :--- | :--- |
| 有数据，且确实是零 | `0` / `¥0.00` / `0%` | 今日没有请求时的今日用量、今日花费 |
| 无定义（分母为 0）或取不到 | `—`（em dash，全站唯一） | 今日无请求时的缓存命中率、余额未配置、查询失败 |
| 正在读取 | `…` | 余额首屏加载 |
| 有请求但缺价格 | `—` + tooltip 说明原因 | 今日花费在有用量但无定价时 |

要点：`–` 与 `—` 在 11–13px 下肉眼几乎无法区分，等于随机，必须只留一种。

实现：`lib/client.js` 的 `NO_VALUE = "—"` 常量是唯一出口，`fmtTokens` / `fmtCompact` / `fmtHit` / `fmtMoney` / `fmtMoneyExact` / `fmtCurrency` / `balanceCompact` 全部走它。

## 二、空态问题

| ID | 级别 | 位置 | 现状 | 处理 |
| :--- | :--- | :--- | :--- | :--- |
| E1 | P0 | 热力图日明细 | `translate("usage.noDay")`，zh/en 都没有 → 显示裸 key `usage.noDay` | ✅ 补「当天无用量记录」/「No usage recorded on this day.」 |
| E2 | P0 | 「另外 N 个会话」按钮 | `usage.moreSessions` 同样缺失 → 显示裸 key，`{value}` 不替换 | ✅ 补「另外 {value} 个会话」 |
| E3 | P1 | 各 formatter | 三种横杠混用：`–` / `—` / `…` | ✅ 统一 `NO_VALUE`，加载态保留 `…` |
| E4 | P1 | 悬浮卡指标行 | 今日花费 `—`、今日用量 `0`、命中率 `–` 并列 | ✅ 有定价且当天无请求 → `¥0.00`；无定价 → `—`；命中率无请求 → `—` + tooltip「今日暂无请求」 |
| E5 | P1 | 命中率趋势 | `Number(null) === 0`，与上轮 0 比较判为 flat，画出 6×6 灰方块 | ✅ `todayHit` 为 null 时直接清空趋势 |
| E6 | P1 | 热力图 | 8 周全 0 时满格灰点，没有文字说明 | ✅ 网格下补「近 8 周暂无记录」 |
| E7 | P2 | 热力图图例 | 整段无数据时「少 □□□□□ 多」照常显示 | ✅ 全 0 时隐藏图例 |
| E8 | P2 | 日明细 | 选中日有数据但无会话归因时只剩表头 | ✅ 补「无会话明细」 |
| E9 | P2 | 面板 footer | 空态拼出「累计用量 0 · 累计命中 –」 | ✅ 命中率不存在时不再拼进累计行 |
| E10 | P2 | 日明细容器 | `jsxs` 收到非数组 children，React 报 "Static children should always be an array" | ✅ 改用 `jsx` |

## 三、可访问性

| ID | 级别 | 位置 | 问题 | 处理 |
| :--- | :--- | :--- | :--- | :--- |
| A1 | P1 | 余额行 | `div` + `onClick`，无 `role`/`tabIndex`/键盘事件；替代入口 `.u_dockSettings` 被隐藏 → 键盘打不开面板 | ✅ `role="button"` + `tabIndex=0` + `aria-expanded` + Enter/Space |
| A2 | P1 | 悬浮卡 | 展开/收起键盘不可达 | ✅ `tabIndex=0` + `aria-expanded` + `aria-label` + Enter/Space（内部余额行事件不受影响） |
| A3 | P1 | 热力图 | 格子 `div` + `onClick`，键盘不可达 | ✅ `role="grid"` / `gridcell`，roving tabindex（单一 Tab 停靠点），方向键移动选中日 |
| A4 | P1 | 弹窗 | 无 `role="dialog"`、无焦点管理 | ✅ `role="dialog"` + `tabIndex=-1`，打开接管焦点、关闭归还触发元素 |

## 四、布局

| ID | 级别 | 位置 | 问题 | 处理 |
| :--- | :--- | :--- | :--- | :--- |
| L1 | P2 | 窄屏媒体查询 | 写了 `top:56px`，基础样式是 `bottom:0`，两端同时生效与 `max-height` 打架 | ✅ 改为 `top:auto;bottom:0;max-height:calc(100dvh - 120px)` |
| L2 | P2 | 指标行 | 空态值只有 `0`，单位为空 | 🟡 保留：`fmtCompact` 在 `<1000` 时本来就是纯整数无单位，`0` 即最低粒度 |
| L3 | P2 | 余额行 chevron | 用文字 `›` 绘制，字形墨迹本身就高于行盒中心，微调 `translateY` 无法真正居中，且旋转 180° 后位移方向会翻转 | ✅ 换成长宽 16 的对称 SVG（路径关于 `(8,8)` 对称），只旋转不位移 |
| L4 | P2 | 折叠态消费字号 | 折叠时降到 `21/25`，与展开态 `32/36` 不一致 | ✅ 删除折叠覆盖，两态同字号 |
| L5 | P2 | 今日花费状态标签 | 只有数字变色表达峰/谷，颜色单靠色相区分，色觉障碍用户读不出 | ✅ 加胶囊标签「峰 / 谷」，底色与时间轴同源；峰 = `#3d2b00` on `#f59e0b`（6.3:1），谷 = `label-primary` on 15% 灰底（亮色 14:1 / 暗色 12:1）。谷不用 `label-secondary` 是因为只有 4.1:1 |

## 五、代码卫生

| ID | 级别 | 位置 | 问题 | 处理 |
| :--- | :--- | :--- | :--- | :--- |
| C1 | P2 | `DayDetail` | 定义后无引用（96 行） | ✅ 删除，连带 `usage.noModels` / `usage.noSessions` 复活为真实使用 |
| C2 | P2 | en 字典 | 18 条 zh 没有的死键（`action.pin`、`hidden.*`、`widget.month`、`heat.today`、`peak.*`） | ✅ 删除 |
| C3 | P2 | 字典 | zh 89 / en 107 不对等 | ✅ 现在 zh 94 / en 94，并加单元测试守住「用到的键两边都有」 |
| C4 | P3 | 全文件 | 13 处原生 `title` 与自定义 `.u_heatTip` 两套提示并存 | 🟡 会话 id 那处已移除，其余保留 |
| C5 | P2 | 热力图提示 | 单位硬编码单数 `token`，`592,295,660 token` 读起来是错的 | ✅ 统一 `fmtTokenCount()`：`1` 用单数，其余复数 |

## 六、侧栏席位（参考 ai-written/dsh-usage-badge）

两者都注册在 `sidebar.footer.action`：席位由侧边栏声明，会传入 `wide`（展开整行 / 收起 36px 方块），条目落位与「设置」行共用同一套流式布局。

差别在于条目是否留在文档流里：

- 该项目的条目是普通流式行（`width:100%;height:36px;border-radius:12px;background:transparent`），展开时是整行、收起时是 36×36 方块，不需要任何位置计算；明细走全屏模态（`position:fixed;inset:0` + 34% 遮罩，居中）。
- 本项目条目是 `position:fixed` 悬浮卡，位置由 `dockMetrics` 现算，因此要额外处理 rail 模式、展开偏移与「更多」按钮避让；弹窗锚定在卡片右侧。

## 七、验证

- `npm run check`：通过。
- `npm test`：119 个测试通过（新增 1 个字典完整性测试、6 个空态/键盘 e2e）。
- 空态截图：`scripts/preview-panel.mjs` 生成 `.preview/panel-empty.html`、`.preview/panel-empty-natural.html`、`.preview/dock-empty.html`。
