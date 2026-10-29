import UIKit
import UniformTypeIdentifiers

/// A local inbox action. No credentials, network requests or containing-app launch APIs.
final class ShareViewController: UIViewController {
    private let status = UILabel(), preview = UITextView(), save = UIButton(type: .system), cancel = UIButton(type: .system)
    private var payload: (name: String, kind: String, text: String)?
    private var progress: Progress?, ticket: UUID?, completed = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        status.numberOfLines = 0; status.font = .preferredFont(forTextStyle: .body); status.adjustsFontForContentSizeCategory = true
        status.text = "正在读取本次分享…"
        preview.isEditable = false; preview.font = .preferredFont(forTextStyle: .body); preview.adjustsFontForContentSizeCategory = true
        preview.backgroundColor = .secondarySystemBackground; preview.layer.cornerRadius = 8
        let heading = UILabel(); heading.text = "保存到 PaperQuay 待处理"; heading.numberOfLines = 0
        heading.font = .preferredFont(forTextStyle: .title2); heading.adjustsFontForContentSizeCategory = true
        let boundary = UILabel(); boundary.numberOfLines = 0; boundary.font = .preferredFont(forTextStyle: .footnote)
        boundary.adjustsFontForContentSizeCategory = true
        boundary.text = "只暂存到本机，不会联网或加入文库。保存后请回到 PaperQuay，选择账号并确认导入。一次支持一项 DOI／链接文字或 JSON、Markdown、BibTeX、RIS 文件。"
        save.setTitle("保存到待处理", for: .normal); save.isEnabled = false
        save.addTarget(self, action: #selector(store), for: .touchUpInside)
        cancel.setTitle("取消", for: .normal); cancel.addTarget(self, action: #selector(close), for: .touchUpInside)
        let scroll = UIScrollView(), stack = UIStackView(arrangedSubviews: [heading, status, preview, boundary, save, cancel])
        scroll.translatesAutoresizingMaskIntoConstraints = false; stack.translatesAutoresizingMaskIntoConstraints = false
        stack.axis = .vertical; stack.spacing = 14
        view.addSubview(scroll); scroll.addSubview(stack)
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 18),
            stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -18),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 18),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -18),
            stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -36),
            preview.heightAnchor.constraint(equalToConstant: 150), save.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
            cancel.heightAnchor.constraint(greaterThanOrEqualToConstant: 44)
        ])
        preferredContentSize = CGSize(width: 360, height: 520)
        receive()
    }
    deinit { progress?.cancel() }
    private func receive() {
        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
        guard providers.count == 1, let provider = providers.first else { fail(.unsupported); return }
        let request = UUID(); ticket = request
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in
            guard let self = self, self.ticket == request else { return }
            self.ticket = nil; self.progress?.cancel(); self.fail(.readFailed)
        }
        let hinted = provider.suggestedName ?? ""
        let knownName = try? IncomingShareStore.fileName(hinted)
        if knownName == nil && ["json", "md", "markdown", "bib", "bibtex", "ris"].contains(URL(fileURLWithPath: hinted).pathExtension.lowercased()) {
            ticket = nil; fail(.unsupported); return
        }
        if knownName == nil && provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
            provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { [weak self] item, _ in
                guard let url = item as? URL, !url.isFileURL else { self?.deliver(request, result: .failure(.unsupported)); return }
                self?.deliver(request, result: .success(("分享的文字或链接", "text", url.absoluteString)))
            }
            return
        }
        let formats: [(String, String)] = [("public.json", "shared.json"), ("net.daringfireball.markdown", "shared.md"),
            ("dev.paperquay.bibliography.bibtex", "shared.bib"), ("org.bibdesk.bibtex", "shared.bib"),
            ("dev.paperquay.bibliography.ris", "shared.ris")]
        if let format = formats.first(where: { provider.hasItemConformingToTypeIdentifier($0.0) }) {
            loadFile(provider, type: format.0, name: knownName ?? format.1, request: request)
        } else if let name = knownName, let type = provider.registeredTypeIdentifiers.first {
            loadFile(provider, type: type, name: name, request: request)
        } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
            progress = provider.loadDataRepresentation(forTypeIdentifier: UTType.plainText.identifier) { [weak self] data, _ in
                guard let data = data, data.count <= IncomingShareStore.maxText,
                      let text = String(data: data, encoding: .utf8) else { self?.deliver(request, result: .failure(.invalid)); return }
                self?.deliver(request, result: .success(("分享的文字或链接", "text", text)))
            }
        } else { ticket = nil; fail(.unsupported) }
    }
    private func loadFile(_ provider: NSItemProvider, type: String, name: String, request: UUID) {
        progress = provider.loadFileRepresentation(forTypeIdentifier: type) { [weak self] url, _ in
            guard let url = url else { self?.deliver(request, result: .failure(.readFailed)); return }
            do {
                // Provider temporary URLs are consumed only inside this callback.
                let source = try IncomingShareStore.fileText(url, displayName: name)
                self?.deliver(request, result: .success((source.name, "file", source.text)))
            } catch { self?.deliver(request, result: .failure(error as? IncomingShareFailure ?? .readFailed)) }
        }
    }
    private func deliver(_ request: UUID, result: Result<(name: String, kind: String, text: String), IncomingShareFailure>) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self, !self.completed, self.ticket == request else { return }
            self.ticket = nil
            switch result {
            case .success(let source):
                do {
                    try IncomingShareStore.validateText(source.text, kind: source.kind)
                    self.payload = source; self.status.text = "\(source.name) · \(source.text.utf8.count) 字节"
                    self.preview.text = String(source.text.prefix(1500)); self.save.isEnabled = true
                } catch { self.fail(error as? IncomingShareFailure ?? .invalid) }
            case .failure(let error): self.fail(error)
            }
        }
    }
    private func fail(_ error: IncomingShareFailure) {
        let messages: [IncomingShareFailure: String] = [.full: "本机待处理收件箱已满，请先回到 PaperQuay 处理现有项目。",
            .unsupported: "本次类型暂不支持。请只分享一项 DOI／链接文字或 UTF-8 JSON、Markdown、BibTeX、RIS 文件。",
            .tooLarge: "文字最多 64 KiB，书目文件最多 4 MiB，请缩小内容。", .invalid: "内容不是有效的受支持文本，未保存。",
            .readFailed: "无法完整读取本次分享，未保存。", .unavailable: "本机共享存储不可用，请检查完整安装包及 App Group 配置。"]
        status.text = messages[error]; save.isEnabled = false
    }
    @objc private func store() {
        guard let source = payload, !completed else { return }
        save.isEnabled = false; cancel.isEnabled = false
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            do {
                try IncomingShareStore.enqueue(name: source.name, kind: source.kind, text: source.text)
                DispatchQueue.main.async { self?.completed = true; self?.extensionContext?.completeRequest(returningItems: nil, completionHandler: nil) }
            } catch {
                DispatchQueue.main.async {
                    self?.fail(error as? IncomingShareFailure ?? .unavailable); self?.cancel.isEnabled = true
                    self?.save.setTitle("重试保存", for: .normal); self?.save.isEnabled = true
                }
            }
        }
    }
    @objc private func close() {
        guard !completed else { return }
        completed = true; ticket = nil; progress?.cancel()
        extensionContext?.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError, userInfo: nil))
    }
}
