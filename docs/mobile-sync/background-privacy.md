# 原生后台隐私

iOS 在 scene 即将失去前台状态时同步覆盖原生窗口，进入后台时再次核对，恢复活动状态后移除。遮罩没有动画，使用系统背景、文字颜色与动态字体，不依赖已经暂停的 JavaScript。

Android 13 及以上关闭最近任务的截图。Android 的任务预览也可能在 Activity 仍为 RESUMED、窗口已经失去焦点时显示实时内容，因此在窗口失焦及 Activity 暂停时覆盖原生 decor；只在已经恢复且窗口取得焦点后移除。恢复回调本身不会解除失焦遮罩。该处理保护后台任务预览，不设置禁止用户主动截图的 FLAG_SECURE。

原生焦点回归位于 `android/app/src/androidTest`，CI 编译测试 APK。测试仅在明确传入 `paperquayOfflineQa=true`、包名后缀为 `.backgroundprivacyqa` 且没有 INTERNET 权限的隔离包上运行；不对用户安装实例调用生命周期测试。真实系统任务卡片的检查还需无保护对照、前台截图、切后台和恢复验证，不能用直接调用焦点回调替代。

平台规则依据 [Apple 的后台快照说明](https://developer.apple.com/library/archive/qa/qa1838/_index.html) 和 [Android Activity API](https://developer.android.com/reference/android/app/Activity#setRecentsScreenshotEnabled(boolean))。实际系统、多窗口、通知遮挡、分享和恢复行为仍需各设备检查；编译通过不能证明 OS 最终保存的任务预览已经不可读。现有用户没有提供四类实机或 iOS 签名渠道，这些验收项目保持待验。
