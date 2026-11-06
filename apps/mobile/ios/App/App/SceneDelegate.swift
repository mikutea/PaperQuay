import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

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
