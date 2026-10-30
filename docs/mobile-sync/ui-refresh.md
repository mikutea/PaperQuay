# 移动端 UI 改版 · 2026-10-30

本轮覆盖实际 React/Capacitor 应用的连接、文库、笔记、账号、AI 设置、导入和阅读工具。正文采用白色/石墨色内容面，导航采用独立的浮层材质；PDF 页面与用户批注颜色保持独立。

## 设计依据

- [Apple HIG · Materials](https://developer.apple.com/design/human-interface-guidelines/materials)：通透材质限定于导航与操作层，正文保留稳定底色。
- [Apple HIG · Tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars)：稳定的带标签导航、保留当前位置和内容状态。
- [Apple HIG · Motion](https://developer.apple.com/design/human-interface-guidelines/motion)：短促、有因果、可中断的反馈，尊重减少动画偏好。
- [WWDC26 · Communicate your brand identity on iOS](https://developer.apple.com/videos/play/wwdc2026/251/)：内容表达产品身份，常规操作遵循熟悉的平台模式。

这是基于 Web 的适配，不声称实现了 SwiftUI 原生 Liquid Glass。系统不支持透明度偏好查询或背景模糊时，控件使用实色底。

小红书以“笔记软件 UI”检索，查看当前加载的约30条结果，并核对以下详情。未能启用可核实的点赞/收藏排序，因此只作为相关样本，不声称全站排名或审美因果。未点赞、收藏、关注或发布内容。

| 样本 | 作者 / 页面时间 | 赞 / 收藏 | 可借鉴之处 |
| --- | --- | --- | --- |
| [NOTED 欢迎界面](https://www.xiaohongshu.com/explore/6adf27ee000000001500ed1f) | 乌头蜜 / 3天前 | 1191 / 379 | 可识别的文档身份 |
| [Cluero 线索笔记](https://www.xiaohongshu.com/explore/698bf820000000000a03e7b7) | peakcoder / 编辑于04-04 | 1026 / 747 | 内容分组和关系表达，未引入画布 |
| [自由笔记交互案例](https://www.xiaohongshu.com/explore/6874d9c0000000000b01e240) | 四喜茶茶 / 2025-07-14 | 568 / 454 | 安静的底色、可辨认的文档预览 |
| [Notein 2.0](https://www.xiaohongshu.com/explore/6a97fb68000000002901a184) | Notein一笔记 / 09-02 | 416 / 109 | 白色文档与蓝色主操作；该帖含抽奖，不能把互动全归因于设计 |

数据为2026-10-30页面可见值，可能变化；视频只核对可见帧与正文，未完成逐帧交互分析。截图和详情记录在任务目录 qa/m3/20261030/ui-refresh。

## 实现

- tokens.css 集中维护语义颜色、明暗主题、材质和动效时间。系统字体优先，中文不套用负字距。
- 文献列表展示标题、作者、来源、阅读状态，摘要保留在详情和搜索中；使用装饰性的文档页标识，不冒充真实 PDF 缩略图。
- 账号信息与设置分组，操作和说明相邻；侧栏图标始终保留可访问名称。
- 底部导航的共享选中背景连续移动；按压即时反馈，取消触摸不触发动作。没有引入动画依赖或锁定输入。
- 内容区为浮层导航保留滚动/焦点避让。窄屏 AI 操作自动换行，大字号长标题可断行；短横屏采用紧凑侧栏，列表独立滚动。
- color-scheme 与明暗 theme-color 元数据和正文主题一致。减少动画关闭过渡；减少透明度、高对比和强制颜色有回退。

## 验收口径

根项目和移动端回归、TypeScript/Vite、实际 Android 构建分别记录。视觉夹具使用独立包 dev.paperquay.mobile.uirefreshqa，移除 INTERNET 权限；应用组件来自产品源码，认证/API/系统分享驱动为明确的合成接口，数据由实际 WorkspaceController 和 IndexedDB 保存。它不能证明真实身份服务、同步服务、模型或 Native SQLite 的本轮验收。

M3 真实服务链仍受此前自动审批拒绝限制，未重试或更换端口/工具绕过。四类实机、现代 WebView、iOS/Xcode 与桌面 Electron Reader 交互仍需独立验收。本轮未 push、合并、发布或替换用户的桌面安装。

## 续作：列表状态与筛选空结果

文库与笔记分别保留当前会话的搜索、筛选和已删除视图，经过账号页、编辑或阅读界面返回时保持。切换账号、身份主体、服务、设备或本地数据代次后清空；旧会话回调不能改写当前查询。搜索词只保存在组件内存，不写入本地偏好或同步数据。登录过期但本地文库仍可读时，可以继续搜索。

搜索或筛选无结果时显示“没有找到匹配内容”，提供“清除搜索与筛选”；不再误报空文库或引导添加首篇文献。仅已删除视图为空时，保留原说明。验证证据见任务目录 qa/m3/20261030/list-state；与上轮视觉及真实服务验收分别记录。
