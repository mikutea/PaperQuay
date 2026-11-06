# 原生后台隐私

iOS 在 scene 即将失去前台状态时同步覆盖原生窗口，进入后台时再次核对，恢复活动状态后移除。遮罩没有动画，使用系统背景、文字颜色与动态字体，不依赖已经暂停的 JavaScript。

Android 13 及以上关闭最近任务的截图；支持的旧系统同时在 Activity 暂停前覆盖原生 decor，恢复后移除。该处理保护后台任务预览，不限制用户在活动阅读界面主动截图。

平台规则依据 [Apple 的后台快照说明](https://developer.apple.com/library/archive/qa/qa1838/_index.html) 和 [Android Activity API](https://developer.android.com/reference/android/app/Activity#setRecentsScreenshotEnabled(boolean))。实际系统、多窗口、通知遮挡、分享和恢复行为仍需各设备检查；编译通过不能证明 OS 最终保存的任务预览已经不可读。现有用户没有提供四类实机或 iOS 签名渠道，这些验收项目保持待验。
