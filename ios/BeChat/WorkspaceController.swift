import UIKit
import WebKit
import AuthenticationServices
import QuickLook

@MainActor
final class WorkspaceController: UIViewController, WKNavigationDelegate, WKScriptMessageHandler, ASWebAuthenticationPresentationContextProviding, QLPreviewControllerDataSource, QLPreviewControllerDelegate, WKDownloadDelegate {
    private var server = ServerAddress.parse(UserDefaults.standard.string(forKey: "workspace") ?? "") ?? ServerAddress.initial
    private var web: WKWebView!
    private var welcome: UIStackView!
    private let detail = UILabel()
    private let openButton = UIButton(type: .system)
    private var authentication: ASWebAuthenticationSession?
    private var currentToken: String?
    private var previewFile: URL?
    private var downloads: [ObjectIdentifier: URL] = [:]
    private let accent = UIColor(red: 0.65, green: 0.72, blue: 1, alpha: 1)
    private let night = UIColor(red: 0.02, green: 0.04, blue: 0.13, alpha: 1)
    private lazy var scratch = FileManager.default.temporaryDirectory.appendingPathComponent("BeChat-attachments", isDirectory: true)
    override func viewDidLoad() {
        super.viewDidLoad()
        title = "BeChat"; view.backgroundColor = night
        navigationItem.rightBarButtonItem = UIBarButtonItem(image: UIImage(systemName:"gearshape"), style:.plain, target:self, action:#selector(changeServer))
        navigationItem.rightBarButtonItem?.accessibilityLabel = "Адрес сервера"
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(self, name:"bechatIdentity")
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        web = WKWebView(frame:.zero, configuration:configuration); web.navigationDelegate = self
        web.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(web)
        NSLayoutConstraint.activate([web.leadingAnchor.constraint(equalTo:view.leadingAnchor),web.trailingAnchor.constraint(equalTo:view.trailingAnchor),web.topAnchor.constraint(equalTo:view.safeAreaLayoutGuide.topAnchor),web.bottomAnchor.constraint(equalTo:view.safeAreaLayoutGuide.bottomAnchor)])
        let heading = UILabel(); heading.text = "BeChat"; heading.textColor = .white
        heading.font = UIFont.systemFont(ofSize:42,weight:.semibold);heading.adjustsFontForContentSizeCategory = true
        detail.textColor = accent; detail.font = .preferredFont(forTextStyle:.body); detail.numberOfLines = 0
        var button = UIButton.Configuration.filled();button.title = "Открыть рабочее пространство";button.baseBackgroundColor = accent;button.baseForegroundColor = night;button.cornerStyle = .medium
        openButton.configuration = button;openButton.addTarget(self,action:#selector(connect),for:.touchUpInside)
        welcome = UIStackView(arrangedSubviews:[heading,detail,openButton]);welcome.axis = .vertical;welcome.spacing = 18;welcome.alignment = .leading
        welcome.translatesAutoresizingMaskIntoConstraints = false;view.addSubview(welcome)
        NSLayoutConstraint.activate([welcome.leadingAnchor.constraint(equalTo:view.safeAreaLayoutGuide.leadingAnchor,constant:24),welcome.trailingAnchor.constraint(equalTo:view.safeAreaLayoutGuide.trailingAnchor,constant:-24),welcome.centerYAnchor.constraint(equalTo:view.safeAreaLayoutGuide.centerYAnchor)])
        try? FileManager.default.removeItem(at:scratch)
        showWelcome("Переписка вашей организации\n"+server.absoluteString)
        if UserDefaults.standard.bool(forKey:"openedWorkspace"){connect()}
    }
    private func showWelcome(_ text:String) {web.isHidden = true; welcome.isHidden = false; detail.text = text}
    @objc private func connect() {
        UserDefaults.standard.set(true,forKey:"openedWorkspace");welcome.isHidden = true;web.isHidden = false
        web.load(URLRequest(url:server,cachePolicy:.reloadIgnoringLocalCacheData,timeoutInterval:25))
    }
    @objc private func changeServer() {
        let alert = UIAlertController(title:"Сервер BeChat",message:"Введите HTTPS-адрес, который дал учредитель.",preferredStyle:.alert)
        alert.addTextField { f in f.text = self.server.absoluteString;f.keyboardType = .URL;f.autocapitalizationType = .none;f.autocorrectionType = .no }
        alert.addAction(UIAlertAction(title:"Отмена",style:.cancel))
        alert.addAction(UIAlertAction(title:"Открыть",style:.default){[weak self,weak alert] _ in
            guard let self else{return}
            guard let url = ServerAddress.parse(alert?.textFields?.first?.text ?? "") else{self.showWelcome("Нужен адрес вида https://bechat.onbequick.ru");return}
            self.authentication?.cancel();self.authentication = nil;self.currentToken = nil
            self.server = url;UserDefaults.standard.set(url.absoluteString,forKey:"workspace");self.connect()
        });present(alert,animated:true)
    }
    func webView(_ webView:WKWebView,didFailProvisionalNavigation navigation:WKNavigation!,withError error:Error){
        if (error as NSError).code != NSURLErrorCancelled {showWelcome("Сервер "+(server.host ?? "")+" недоступен. Проверьте подключение и повторите попытку.")}
    }
    func webViewWebContentProcessDidTerminate(_ webView:WKWebView){connect()}
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy)->Void) {
        guard let url=action.request.url else{decisionHandler(.cancel);return}
        if url.scheme=="blob" && url.absoluteString.hasPrefix("blob:"+server.absoluteString+"/"){decisionHandler(action.shouldPerformDownload ? .download : .allow);return}
        if ServerAddress.sameOrigin(url,server) {decisionHandler(action.shouldPerformDownload ? .download : .allow);return}
        if url.absoluteString=="about:blank" && action.targetFrame?.isMainFrame==false {decisionHandler(.allow);return}
        decisionHandler(.cancel)
        if action.navigationType == .linkActivated && url.scheme=="https" {UIApplication.shared.open(url)}
    }
    func userContentController(_ controller: WKUserContentController,didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let page=message.frameInfo.request.url, ServerAddress.sameOrigin(page,server), let object=message.body as? [String:Any],let type=object["type"] as? String else{return}
        switch type {
        case "ready": if let cached=currentToken ?? SessionVault.get(server){supply(cached,at:server)}
        case "login": startLogin()
        case "logout","expired": currentToken=nil;SessionVault.clear(server)
        case "document": if let id=object["id"] as? String, UUID(uuidString:id) != nil,let name=object["name"] as? String {Task {await showFile(id,name:name)}}
        default: break
        }
    }
    private func status(_ message: String) {
        web.callAsyncJavaScript("window.beChatNativeStatus(message)", arguments: ["message": message], in: nil, in: .page) { _ in }
    }
    private func supply(_ value:String,at origin:URL){
        guard server==origin,let page=web.url,ServerAddress.sameOrigin(page,origin) else{return}
        web.callAsyncJavaScript("return await window.beChatNativeSession(token)", arguments: ["token": value], in: nil, in: .page) { [weak self] outcome in
            guard let self,self.server==origin else{return}
            if case .success(let result)=outcome,let ok=result as? Bool,ok{self.currentToken=value;SessionVault.save(value,for:origin)}
            else{self.currentToken=nil;SessionVault.clear(origin)}
        }
    }
    func presentationAnchor(for session: ASWebAuthenticationSession)->ASPresentationAnchor {view.window ?? ASPresentationAnchor()}
    private func startLogin() {
        guard authentication==nil else{return}
        let origin=server
        do {
            let proof=try Proof()
            var url=URLComponents(url:origin.appendingPathComponent("auth/start"),resolvingAgainstBaseURL:false)!
            url.queryItems=[URLQueryItem(name:"client",value:"ios"),URLQueryItem(name:"challenge",value:proof.challenge),URLQueryItem(name:"nonce",value:proof.nonce)]
            let auth=ASWebAuthenticationSession(url:url.url!,callbackURLScheme:"bechat-auth"){[weak self] callback,error in
                Task { @MainActor in
                    guard let self,self.server==origin else{return};self.authentication=nil
                    guard error==nil,let callback,let parts=URLComponents(url:callback,resolvingAgainstBaseURL:false),
                          parts.scheme=="bechat-auth",parts.host=="oauth",parts.path=="/complete",parts.queryItems?.first(where:{$0.name=="nonce"})?.value==proof.nonce,
                          let ticket=parts.queryItems?.first(where:{$0.name=="ticket"})?.value else{self.status("Вход не завершён. Выберите аккаунт организации и попробуйте ещё раз.");return}
                    do{
                        var request=URLRequest(url:origin.appendingPathComponent("auth/exchange"));request.httpMethod="POST";request.setValue("application/json",forHTTPHeaderField:"Content-Type")
                        request.httpBody=try JSONEncoder().encode(["client":"ios","ticket":ticket,"verifier":proof.verifier])
                        let (data,response)=try await DirectConnection.session.data(for:request)
                        guard (response as? HTTPURLResponse)?.statusCode==200,let json=try JSONSerialization.jsonObject(with:data) as? [String:Any],let token=json["token"] as? String,token.utf8.count==43 else{throw ServiceError("Повторите вход через amoCRM.")}
                        self.supply(token,at:origin)
                    }catch{self.status("Сервер не подтвердил вход. Повторите попытку.")}
                }
            }
            auth.presentationContextProvider=self;authentication=auth
            if !auth.start(){authentication=nil;status("Не удалось открыть страницу входа amoCRM.")}
        }catch{status(error.localizedDescription)}
    }
    private func temporaryFile(_ name:String) throws ->URL {
        let folder=scratch.appendingPathComponent(UUID().uuidString,isDirectory:true)
        try FileManager.default.createDirectory(at:folder,withIntermediateDirectories:true)
        let safe=(name as NSString).lastPathComponent
        guard !["",".",".."].contains(safe) else{throw ServiceError("Некорректное имя файла")}
        return folder.appendingPathComponent(safe)
    }
    private func showFile(_ id:String,name:String) async {
        guard let token=currentToken,["pdf","docx"].contains((name as NSString).pathExtension.lowercased()) else{return}
        let origin=server
        do{
            var request=URLRequest(url:origin.appendingPathComponent("api/files").appendingPathComponent(id))
            request.setValue("Bearer "+token,forHTTPHeaderField:"Authorization")
            let(data,response)=try await DirectConnection.session.data(for:request)
            guard server==origin,currentToken==token,(response as? HTTPURLResponse)?.statusCode==200,data.count<=8*1024*1024 else{throw ServiceError("Файл недоступен.")}
            let url=try temporaryFile(name);try data.write(to:url,options:[.atomic,.completeFileProtection])
            previewFile=url;let q=QLPreviewController();q.dataSource=self;q.delegate=self;present(q,animated:true)
        }catch{let alert=UIAlertController(title:"Документ",message:"Не удалось открыть вложение.",preferredStyle:.alert);alert.addAction(UIAlertAction(title:"Закрыть",style:.cancel));present(alert,animated:true)}
    }
    func numberOfPreviewItems(in controller:QLPreviewController)->Int{previewFile==nil ? 0 : 1}
    func previewController(_ controller:QLPreviewController,previewItemAt index:Int)->QLPreviewItem{previewFile! as NSURL}
    func previewControllerDidDismiss(_ controller:QLPreviewController){if let file=previewFile{try? FileManager.default.removeItem(at:file.deletingLastPathComponent());previewFile=nil}}
    func webView(_ webView:WKWebView,navigationAction:WKNavigationAction,didBecome download:WKDownload){download.delegate=self}
    func download(_ download:WKDownload,decideDestinationUsing response:URLResponse,suggestedFilename:String,completionHandler:@escaping(URL?)->Void){
        let file=try? temporaryFile(suggestedFilename);downloads[ObjectIdentifier(download)]=file;completionHandler(file)
    }
    func downloadDidFinish(_ download:WKDownload){
        guard let file=downloads.removeValue(forKey:ObjectIdentifier(download)) else{return}
        let sheet=UIActivityViewController(activityItems:[file],applicationActivities:nil);sheet.popoverPresentationController?.sourceView=view
        sheet.completionWithItemsHandler={_,_,_,_ in try? FileManager.default.removeItem(at:file.deletingLastPathComponent())};present(sheet,animated:true)
    }
    func download(_ download:WKDownload,didFailWithError error:Error,resumeData:Data?){if let file=downloads.removeValue(forKey:ObjectIdentifier(download)){try? FileManager.default.removeItem(at:file.deletingLastPathComponent())}}
}

