import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private var privacyCover: UIView?

    // Scene snapshots can be captured before JavaScript receives a background
    // event. Cover the native window synchronously, without an animation.
    private func hidePrivateContent() {
        guard let window = window else { return }
        if let cover = privacyCover {
            window.bringSubviewToFront(cover)
            return
        }
        let cover = UIView(frame: window.bounds)
        cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        cover.backgroundColor = .systemBackground
        cover.isAccessibilityElement = true
        cover.accessibilityLabel = "PaperQuay 内容已隐藏"
        cover.accessibilityViewIsModal = true
        let label = UILabel()
        label.text = "PaperQuay"
        label.font = .preferredFont(forTextStyle: .headline)
        label.adjustsFontForContentSizeCategory = true
        label.textColor = .label
        label.textAlignment = .center
        label.numberOfLines = 0
        label.translatesAutoresizingMaskIntoConstraints = false
        cover.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: cover.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: cover.centerYAnchor),
            label.leadingAnchor.constraint(greaterThanOrEqualTo: cover.leadingAnchor, constant: 24),
            label.trailingAnchor.constraint(lessThanOrEqualTo: cover.trailingAnchor, constant: -24)
        ])
        window.addSubview(cover)
        privacyCover = cover
    }

    func sceneWillResignActive(_ scene: UIScene) {
        hidePrivateContent()
    }

    func sceneDidEnterBackground(_ scene: UIScene) {
        hidePrivateContent()
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        privacyCover?.removeFromSuperview()
        privacyCover = nil
    }

    func sceneDidDisconnect(_ scene: UIScene) {
        privacyCover?.removeFromSuperview()
        privacyCover = nil
    }

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = IncomingShareBridgeViewController()
        window?.makeKeyAndVisible()

        let files = connectionOptions.urlContexts.filter { $0.url.isFileURL }
        if files.isEmpty {
            SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
        } else {
            files.forEach { IncomingShareDocumentOpen.accept($0.url) }
            let callbacks = Set(connectionOptions.urlContexts.filter { !$0.url.isFileURL })
            if !callbacks.isEmpty { SceneDelegateProxy.shared.scene(scene, openURLContexts: callbacks) }
            connectionOptions.userActivities.forEach { SceneDelegateProxy.shared.scene(scene, continue: $0) }
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        URLContexts.filter { $0.url.isFileURL }.forEach { IncomingShareDocumentOpen.accept($0.url) }
        let callbacks = Set(URLContexts.filter { !$0.url.isFileURL })
        if !callbacks.isEmpty { SceneDelegateProxy.shared.scene(scene, openURLContexts: callbacks) }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
