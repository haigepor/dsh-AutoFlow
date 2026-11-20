## Codex Subscription 0.2.10

- Image tasks retain available network failure and response details when a stream ends unexpectedly.

## Codex Subscription 0.2.10 更新说明

- 生图响应中断时，任务保留可用的网络错误与响应信息，便于核对请求。

## Codex Subscription 0.2.9

Generated image previews and call details appear in one collapsible row at the original request in the conversation.

## Codex Subscription 0.2.9 更新说明

生成的图片预览和调用详情集中在对话原请求位置的折叠行内。

## Codex Subscription 0.2.8

Image-account selectors read local account metadata without waiting for network quota refreshes. Account management and actual image admission retain their quota, authorization and spending checks. Existing accounts and tasks are retained.

Included with AutoFlow Desktop 0.2.2-rc.1.20261115.3. Restart after active tasks finish to load the matching Host and Client; existing configuration and history are retained.

## Codex Subscription 0.2.8 更新说明

生图账号选择读取本地账号信息，无需等待网络配额刷新；账号管理页和实际生图受理继续执行原有额度、授权及消费检查。保留现有账号和历史任务。

随 AutoFlow Desktop 0.2.2-rc.1.20261115.3 提供；任务结束后重启以加载配套 Host 和 Client，保留现有配置和历史。

## Codex Subscription 0.2.7

Report Chat image counters separately from Work/Codex quota. Keep the last successful observation after a refused or invalid read, and label Chat image counts as unverified metering rather than available Visual Curator uses. Account authorization and spending policy remain unchanged.

The account-page presentation requires AutoFlow Desktop 0.2.2-rc.1.20261115.2. Existing accounts, settings and historical tasks are retained.

## Codex Subscription 0.2.7 更新说明

分开报告 Chat 图片计数与 Work/Codex 额度。读取被拒绝或返回无效数据时保留上次成功值，Chat 图片计数标注为计量未验证，不作为视觉策展可用次数。账号授权与消费策略保持不变。

账号页展示需要配套 AutoFlow Desktop 0.2.2-rc.1.20261115.2，保留现有账号、设置及历史任务。

## Codex Subscription 0.2.6

Expose selectable subscription image accounts to Visual Curator. Preserve image-edit masks, durable task handles and cancellation receipts when a specific account is selected.

Included with AutoFlow Desktop 0.2.2-rc.1.20261113.2. Existing settings, accounts, task data and saved results are retained.

## Codex Subscription 0.2.6 更新说明

视觉策展可以指定订阅生图账号；指定账号后仍保留图片编辑蒙版、持久化任务句柄及取消回执。

随 AutoFlow Desktop 0.2.2-rc.1.20261113.2 提供，保留现有设置、账号、任务数据和已保存结果。

## Codex Subscription 0.2.5

Prefer the configured image-generation model when listing subscription image models, so image workflows use the owner's default choice. Continue to preserve image-edit masks, accepted operations, task ownership and cancellation receipts during recovery.

Included with AutoFlow Desktop 0.2.2-rc.1.20261112.1. Update after active tasks finish and restart AutoFlow. Existing settings, accounts, reference data and saved results are retained.

## Codex Subscription 0.2.5 更新说明

列出生图模型时优先展示已配置的默认模型，让图片流程采用用户的默认选择；恢复时继续保留编辑蒙版、已受理操作、任务归属与取消回执。

随 AutoFlow Desktop 0.2.2-rc.1.20261112.1 一同提供。请在当前任务结束后更新并重启；保留现有设置、账号、参考数据和已保存结果。
