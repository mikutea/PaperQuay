import Capacitor

final class IncomingShareBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(PaperQuayIncomingSharePlugin())
    }
}
