# 知乎 (www.zhihu.com)

## Overview
中文问答社区。热榜、问题详情、个人 feed 需要登录态。推荐区/搜索是 SPA，热榜是 SSR-friendly。

## Known adapters
- `zhihu hot` — 知乎热榜（需登录）
- `zhihu feed` — 知乎推荐 Feed（需登录）

## Key URL patterns
- 热榜：`https://www.zhihu.com/hot`
- 问题详情：`https://www.zhihu.com/question/<id>`
- 搜索：`https://www.zhihu.com/search?q=<q>&type=content`

## Stable CSS selectors
- 热榜条目：`.HotItem`
- 排名：`.HotItem-rank`
- 标题：`.HotItem-title`
- 摘要：`.HotItem-excerpt`
- 热度/互动文字：`.HotItem-metrics`
- 标签（热/沸/新）：`.HotItem-label`
- 内容链接：`.HotItem-content a[href*="/question/"]`

## Login requirements
热榜、推荐、问题详情均需登录。未登录会被强制跳转到 `/signin?next=...`。

## Known pitfalls
- **强制登录**：所有有价值页面都跳登录页。`goto` 后必须检查 `location.href` 是否被重定向到 `/signin`。
- **metrics 混入动作文字**：`.HotItem-metrics` 的 textContent 会包含"分享"等按钮文字。提取热度时需 `replace(/分享.*$/, '')`。
- **tag 可选**：多数条目没有 `.HotItem-label`（只有热/沸/新等前几名有）—必须用 `?.textContent?.trim() || ''` 而非强制匹配。
- **rank 文本即数字**：`.HotItem-rank` 的 textContent 直接是字符串数字（"1"、"2"…）。parseInt 安全。
