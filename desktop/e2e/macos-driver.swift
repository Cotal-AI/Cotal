import Darwin
import Foundation
import AppKit
import ApplicationServices

var windowSelectionContext: [String: Any]?
var loginDiagnosticContext: [String: Any]?
let loginDiagnosticInvocation = UUID().uuidString
func loginReceipt(_ phase: String, _ fields: [String: Any] = [:]) {
    var record = fields
    record["phase"] = phase
    record["schema"] = 1
    record["operation"] = "disable-login"
    record["invocation"] = loginDiagnosticInvocation
    record["timestamp"] = ISO8601DateFormatter().string(from: Date())
    if let data = try? JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]),
       let text = String(data: data, encoding: .utf8) {
        fputs("macOS driver login diagnostic: \(text)\n", stderr)
    }
}
func fail(_ message: String) -> Never {
    if let context = loginDiagnosticContext {
        loginReceipt("failure", context.merging(["message": message]) { _, new in new })
    }
    if let context = windowSelectionContext,
       let data = try? JSONSerialization.data(withJSONObject: context, options: [.sortedKeys]),
       let text = String(data: data, encoding: .utf8) {
        fputs("macOS driver window selection: \(text)\n", stderr)
    }
    fputs("macOS driver: \(message)\n", stderr)
    exit(1)
}
func output(_ value: Any) {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]),
          let text = String(data: data, encoding: .utf8) else { fail("cannot encode reply") }
    print(text)
}
guard CommandLine.arguments.count >= 3, let pid = pid_t(CommandLine.arguments[1]), pid > 0,
      let running = NSRunningApplication(processIdentifier: pid), !running.isTerminated else { fail("owned PID is not running") }
guard AXIsProcessTrusted() else { fail("Accessibility permission is required for the Swift helper") }
let app = AXUIElementCreateApplication(pid)
AXUIElementSetMessagingTimeout(app, 5)
let operation = CommandLine.arguments[2]
let args = Array(CommandLine.arguments.dropFirst(3))
func arg(_ index: Int) -> String {
    guard args.indices.contains(index) else { fail("missing argument \(index)") }
    return args[index]
}
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func children(_ element: AXUIElement) -> [AXUIElement] { attribute(element, "AXChildren") as? [AXUIElement] ?? [] }
func nodes(_ element: AXUIElement, _ depth: Int = 0) -> [AXUIElement] {
    guard depth < 40 else { fail("AX tree exceeds traversal limit") }
    return [element] + children(element).flatMap { nodes($0, depth + 1) }
}
func string(_ element: AXUIElement, _ name: String) -> String { attribute(element, name) as? String ?? "" }
func domAttribute(_ element: AXUIElement, _ name: String) -> String? {
    // WebKit versions may not expose arbitrary DOM attributes. Never substitute labels for data-space.
    var value: CFTypeRef?
    let result = AXUIElementCopyParameterizedAttributeValue(element, "AXDOMAttribute" as CFString, name as CFString, &value)
    return result == .success ? value as? String : nil
}
func matches(_ id: String, testId: Bool = false) -> [AXUIElement] {
    guard id.range(of: "^[a-z][a-z0-9-]*$", options: .regularExpression) != nil else { fail("invalid selector") }
    let tree = nodes(app)
    if testId {
        // Test IDs are not inherently accessible. A same-named DOM ID is an exact selector too.
        let found = tree.filter { domAttribute($0, "data-testid") == id || string($0, "AXDOMIdentifier") == id }
        if found.isEmpty && !tree.contains(where: { domAttribute($0, "data-testid") != nil }) {
            fail("WebKit does not expose data-testid through AXDOMAttribute; add stable DOM IDs to owned controls")
        }
        return found
    }
    return tree.filter { string($0, "AXDOMIdentifier") == id }
}
func unique(_ elements: [AXUIElement]) -> AXUIElement {
    guard elements.count == 1 else { fail("selector must name one element, found \(elements.count)") }
    return elements[0]
}
func bounds(_ element: AXUIElement) -> CGRect? {
    guard let p = attribute(element, "AXPosition"), let s = attribute(element, "AXSize"),
          CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &size) else { return nil }
    return CGRect(origin: point, size: size)
}
func enabled(_ element: AXUIElement) -> Bool { attribute(element, "AXEnabled") as? Bool ?? false }
func axDump() -> [[String: Any]] {
    var result: [[String: Any]] = []
    func visit(_ element: AXUIElement, parent: Int?, depth: Int) {
        guard depth < 40 else { fail("AX tree exceeds traversal limit") }
        var owner: pid_t = 0
        let ownerResult = AXUIElementGetPid(element, &owner)
        guard ownerResult == .success, owner == pid else {
            result.append(["parent": parent.map { $0 as Any } ?? NSNull(), "depth": depth,
                           "boundary": "outside-owned-pid", "pid": owner, "error": ownerResult.rawValue])
            return
        }
        let index = result.count
        var record: [String: Any] = [
            "index": index, "parent": parent.map { $0 as Any } ?? NSNull(), "depth": depth,
            "id": string(element, "AXDOMIdentifier"), "role": string(element, "AXRole"),
            "title": string(element, "AXTitle"), "description": string(element, "AXDescription"),
            "value": attribute(element, "AXValue") ?? NSNull(), "enabled": enabled(element),
            "bounds": NSNull(),
        ]
        // AXValue can also be an opaque native object. Preserve only JSON-compatible values.
        if !JSONSerialization.isValidJSONObject([record["value"]!]) { record["value"] = NSNull() }
        if let rect = bounds(element) {
            record["bounds"] = ["x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height]
        }
        result.append(record)
        for child in children(element) { visit(child, parent: index, depth: depth + 1) }
    }
    visit(app, parent: nil, depth: 0)
    return result
}
func visible(_ element: AXUIElement) -> Bool {
    guard attribute(element, "AXHidden") as? Bool != true, let rect = bounds(element) else { return false }
    return rect.width > 0 && rect.height > 0
}
func activate() {
    guard running.activate(options: [.activateIgnoringOtherApps]) else { fail("cannot activate owned app") }
    Thread.sleep(forTimeInterval: 0.15)
}
var loginDelivery = "initial"
var firstLoginPost: Int64 = 0
var loginCursor = ""
func receiptPolicy(_ mode: String, _ value: String, _ time: String) -> String {
    let env = ProcessInfo.processInfo.environment
    guard let node = env["COTAL_MAC_LOGIN_NODE"], let policy = env["COTAL_MAC_LOGIN_POLICY"] else { fail("missing receipt policy") }
    let process = Process()
    let pipe = Pipe()
    process.executableURL = URL(fileURLWithPath: node)
    process.arguments = [policy, mode, value, time]
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice
    do { try process.run() } catch { fail("cannot run owned receipt policy") }
    let deadline = Date().addingTimeInterval(2)
    while process.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.01) }
    if process.isRunning {
        process.terminate()
        _ = Darwin.kill(process.processIdentifier, SIGKILL)
        process.waitUntilExit()
        fail("receipt policy timed out")
    }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    guard process.terminationStatus == 0, let result = String(data: data, encoding: .utf8) else { fail("owned receipt gate refused \(mode)") }
    return result.trimmingCharacters(in: .whitespacesAndNewlines)
}
func focusReceipt(_ phase: String, _ window: AXUIElement) -> Bool {
    let front = NSWorkspace.shared.frontmostApplication
    func describe(_ name: String) -> [String: Any] {
        guard let value = attribute(app, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return ["available": false] }
        let w = value as! AXUIElement
        var owner: pid_t = 0
        let result = AXUIElementGetPid(w, &owner)
        return ["role": string(w, "AXRole"), "title": string(w, "AXTitle"), "pid": owner,
                "owned": result == .success && owner == pid, "selected": CFEqual(w, window),
                "AXMain": attribute(w, "AXMain") as? Bool ?? false,
                "AXFocused": attribute(w, "AXFocused") as? Bool ?? false]
    }
    let focused = describe("AXFocusedWindow")
    let main = describe("AXMainWindow")
    loginReceipt(phase, ["pid": pid, "delivery": loginDelivery, "frontmostPID": front?.processIdentifier ?? 0,
                         "frontmostBundleID": front?.bundleIdentifier ?? "unavailable", "isActive": running.isActive,
                         "focusedWindow": focused, "mainWindow": main, "AppKitKeyWindow": "unavailable AXFocusedWindow is a proxy only"])
    return running.isActive && front?.processIdentifier == pid && focused["owned"] as? Bool == true && focused["selected"] as? Bool == true && main["owned"] as? Bool == true && main["selected"] as? Bool == true
}
func prepareLoginWindow() -> AXUIElement {
    let window = appWindow()
    activate()
    guard AXUIElementPerformAction(window, kAXRaiseAction as CFString) == .success else { fail("cannot raise selected owned window") }
    for name in ["AXMain", "AXFocused"] {
        if attribute(window, name) as? Bool == true { continue }
        var settable: DarwinBoolean = false
        let admission = AXUIElementIsAttributeSettable(window, name as CFString, &settable)
        loginReceipt("focus-write-admission", ["pid": pid, "attribute": name, "error": admission.rawValue, "settable": settable.boolValue])
        guard admission == .success, settable.boolValue else { fail("selected owned window attribute is not settable: \(name)") }
        guard AXUIElementSetAttributeValue(window, name as CFString, kCFBooleanTrue) == .success else { fail("cannot set selected owned window attribute: \(name)") }
    }
    let deadline = Date().addingTimeInterval(2)
    repeat {
        if focusReceipt("activation-observation", window) { return window }
        Thread.sleep(forTimeInterval: 0.1)
    } while Date() < deadline
    fail("owned active focused window verification timed out")
}
func press(_ element: AXUIElement) {
    guard enabled(element), visible(element), let rect = bounds(element) else { fail("control is not actionable") }
    let loginWindow: AXUIElement? = operation == "disable-login" ? prepareLoginWindow() : nil
    if loginWindow == nil { activate() }
    let refreshed = loginWindow == nil ? rect : bounds(loginCheckboxState().element)
    guard let currentRect = refreshed else { fail("control bounds unavailable after activation") }
    let point = CGPoint(x: currentRect.midX, y: currentRect.midY)
    // Refuse a stale or occluded coordinate instead of clicking another application's surface.
    var hit: AXUIElement?
    let hitResult = AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &hit)
    if operation == "disable-login" {
        loginReceipt("input-hit", ["pid": pid, "hitError": hitResult.rawValue, "x": point.x, "y": point.y])
    }
    guard hitResult == .success,
          let target = hit else { fail("cannot hit-test control") }
    var owner: pid_t = 0
    let ownerResult = AXUIElementGetPid(target, &owner)
    if operation == "disable-login" {
        loginReceipt("input-owner", ["pid": pid, "hitPID": owner, "pidError": ownerResult.rawValue,
                                     "owned": ownerResult == .success && owner == pid])
    }
    guard ownerResult == .success, owner == pid else { fail("control is obscured by another process") }
    if operation == "disable-login" {
        loginReceipt("input-control", ["pid": pid, "hitRole": string(target, "AXRole"), "hitID": string(target, "AXDOMIdentifier")])
    }
    if let window = loginWindow {
        guard string(target, "AXDOMIdentifier") == "autostart", string(target, "AXRole") == "AXCheckBox" else { fail("hit test did not select exact autostart checkbox") }
        guard focusReceipt("at-post", window), CFEqual(appWindow(), window), loginCheckboxState().value == 1 else { fail("login state or window changed before post") }
        if loginDelivery == "redelivery-1" {
            // Receipt emission is asynchronous. This is absence as of this read,
            // not atomic proof that the first delivery cannot arrive later.
            _ = receiptPolicy("check", loginCursor, String(firstLoginPost))
            guard loginCheckboxState().value == 1 else { fail("login state changed at redelivery gate") }
            _ = receiptPolicy("check", loginCursor, String(firstLoginPost))
        } else {
            guard let context = ProcessInfo.processInfo.environment["COTAL_DESKTOP_E2E_CONTEXT"] else { fail("missing native context") }
            loginCursor = receiptPolicy("baseline", context, String(pid))
            firstLoginPost = Int64(Date().timeIntervalSince1970 * 1000)
        }
        loginReceipt("delivery-post", ["pid": pid, "delivery": loginDelivery, "firstPostUnixMs": firstLoginPost])
    }
    for kind in [CGEventType.mouseMoved, .leftMouseDown, .leftMouseUp] {
        guard let event = CGEvent(mouseEventSource: nil, mouseType: kind, mouseCursorPosition: point, mouseButton: .left) else { fail("cannot create mouse event") }
        event.post(tap: .cghidEventTap)
        if operation == "disable-login" {
            // CGEvent.post returns Void. This records dispatch, not delivery or a state change.
            loginReceipt("input-dispatch", ["eventType": kind.rawValue, "result": "post-called-no-delivery-ack", "pid": pid, "delivery": loginDelivery])
        }
        Thread.sleep(forTimeInterval: 0.1)
    }
}
func key(_ code: CGKeyCode, flags: CGEventFlags = []) {
    for down in [true, false] {
        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down) else { fail("cannot create key event") }
        event.flags = flags
        event.postToPid(pid)
    }
}
func text(_ element: AXUIElement) -> String {
    for name in ["AXValue", "AXTitle", "AXDescription"] {
        let value = string(element, name)
        if !value.isEmpty { return value }
    }
    return children(element).map(text).filter { !$0.isEmpty }.joined(separator: " ")
}
func appWindow() -> AXUIElement {
    // AXWindows describes the app's windows, not a unique document window.
    // AXWindow and AXHelpTag are distinct native roles. Keep the configured title
    // and PID fences, and refuse two matching app windows rather than picking one.
    var value: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value)
    windowSelectionContext = ["operation": operation, "pid": pid, "source": "AXWindows",
                              "attributeError": result.rawValue, "candidates": [], "selectedIndexes": []]
    guard result == .success, let windows = value as? [AXUIElement] else { fail("cannot read owned AXWindows") }
    var candidates: [[String: Any]] = []
    var selectedIndexes: [Int] = []
    for (index, window) in windows.enumerated() {
        var owner: pid_t = 0
        let ownerResult = AXUIElementGetPid(window, &owner)
        let role = string(window, "AXRole")
        let title = string(window, "AXTitle")
        let hidden = attribute(window, "AXHidden") as? Bool
        let rect = bounds(window)
        let isVisible = hidden != true && rect.map { $0.width > 0 && $0.height > 0 } == true
        let selected = ownerResult == .success && owner == pid && role == kAXWindowRole && title == "Cotal" && isVisible
        var candidate: [String: Any] = [
            "index": index, "pid": owner, "pidError": ownerResult.rawValue,
            "role": role, "subrole": string(window, "AXSubrole"), "title": title,
            "identifier": string(window, "AXIdentifier"), "domIdentifier": string(window, "AXDOMIdentifier"),
            "hidden": hidden.map { $0 as Any } ?? NSNull(), "visible": isVisible,
            "bounds": NSNull(), "selected": selected,
        ]
        if let rect = rect {
            candidate["bounds"] = ["x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height]
        }
        candidates.append(candidate)
        if selected { selectedIndexes.append(index) }
    }
    windowSelectionContext?["candidates"] = candidates
    windowSelectionContext?["selectedIndexes"] = selectedIndexes
    guard selectedIndexes.count == 1 else { fail("selector must name one visible owned Cotal AXWindow, found \(selectedIndexes.count)") }
    return windows[selectedIndexes[0]]
}
func windowVisible() -> Bool {
    guard let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { fail("cannot inspect on-screen windows") }
    return info.contains { ($0[kCGWindowOwnerPID as String] as? Int32) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }
}
// Read only exact IDs below the selected owned window. Missing is readiness,
// ambiguity and ownership failures are refusals, never alternative selectors.
func settingsControls() -> (AXUIElement, AXUIElement) {
    let deadline = Date().addingTimeInterval(5)
    var observation = ""
    repeat {
        guard !running.isTerminated else { fail("owned app exited during Settings readiness") }
        let tree = nodes(appWindow())
        let headings = tree.filter { string($0, "AXDOMIdentifier") == "settings-title" }
        let backs = tree.filter { string($0, "AXDOMIdentifier") == "open-settings" }
        observation = "settings-title count=\(headings.count), open-settings count=\(backs.count)"
        guard headings.count <= 1, backs.count <= 1 else { fail("ambiguous Settings selector: \(observation)") }
        if let heading = headings.first, let back = backs.first {
            for control in [heading, back] {
                var owner: pid_t = 0
                guard AXUIElementGetPid(control, &owner) == .success, owner == pid else { fail("Settings control is outside owned PID") }
            }
            let title = text(heading)
            let label = text(back)
            observation += ", title=\(title), label=\(label), role=\(string(back, "AXRole")), headingVisible=\(visible(heading)), backVisible=\(visible(back)), backEnabled=\(enabled(back))"
            if visible(heading), title == "Settings", visible(back), enabled(back), label == "Back", string(back, "AXRole") == "AXButton" {
                return (heading, back)
            }
        }
        Thread.sleep(forTimeInterval: 0.1)
    } while Date() < deadline
    fail("Settings readiness timed out: \(observation)")
}
func loginCheckboxState() -> (element: AXUIElement, value: Int) {
    guard !running.isTerminated else { fail("owned app exited during autostart observation") }
    let found = nodes(appWindow()).filter { string($0, "AXDOMIdentifier") == "autostart" }
    guard found.count == 1 else { fail("autostart exact selector count=\(found.count)") }
    let checkbox = found[0]
    // Descendant scope comes from the exact owned window, not a new parent-PID
    // requirement on WebKit's AX object. press retains its native hit PID fence.
    // Async preference writes can disable the control while state is observed.
    guard string(checkbox, "AXRole") == "AXCheckBox", visible(checkbox) else { fail("autostart is not a visible checkbox") }
    var raw: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(checkbox, "AXValue" as CFString, &raw)
    guard result == .success, let number = raw as? NSNumber, number == 0 || number == 1 else {
        fail("unsupported autostart AXValue: error=\(result.rawValue), value=\(String(describing: raw))")
    }
    loginDiagnosticContext = ["pid": pid, "id": string(checkbox, "AXDOMIdentifier"),
                              "role": string(checkbox, "AXRole"), "AXValue": number.intValue,
                              "enabled": enabled(checkbox), "visible": visible(checkbox),
                              "window": windowSelectionContext ?? [:]]
    if let rect = bounds(checkbox) {
        loginDiagnosticContext?["controlBounds"] = ["x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height]
    }
    return (checkbox, number.intValue)
}
switch operation {
case "ready": output(true)
case "describe": output(["pid": pid, "visible": windowVisible()])
case "ax-dump": output(["pid": pid, "nodes": axDump()])
case "window-visible": output(windowVisible())
case "displayed":
    let found = matches(arg(0))
    guard found.count <= 1 else { fail("ambiguous DOM ID") }
    output(found.first.map(visible) ?? false)
case "enabled": output(enabled(unique(matches(arg(0)))))
case "text":
    if arg(0) == "tray-label" {
        // The retained native AX tree exposes machine-details and its header parent's
        // anonymous status text, but drops the status span's DOM ID. The journey also
        // says Ready, so never search the whole window for that expected word.
        let details = unique(matches("machine-details"))
        guard let parent = attribute(details, "AXParent"), CFGetTypeID(parent) == AXUIElementGetTypeID() else {
            fail("machine-details has no accessible header parent")
        }
        let header = parent as! AXUIElement
        let states: Set<String> = ["Not connected", "Ready", "Connected", "Starting", "Sign in required", "Checking connection"]
        let statuses = children(header).filter { string($0, "AXRole") == "AXStaticText" && states.contains(text($0)) }
        output(text(unique(statuses)))
    } else { output(text(unique(matches(arg(0))))) }
case "click": press(unique(matches(arg(0)))); output(true)
case "click-test-id": press(unique(matches(arg(0), testId: true))); output(true)
case "test-id-attributes":
    output(matches(arg(0), testId: true).map { node -> String in
        guard let value = domAttribute(node, arg(1)) else { fail("WebKit does not expose requested DOM attribute \(arg(1))") }
        return value
    })
case "fill":
    press(unique(matches(arg(0))))
    key(0, flags: .maskCommand)
    let units = Array(arg(1).utf16)
    guard let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else { fail("cannot create text event") }
    if !units.isEmpty {
        units.withUnsafeBufferPointer { buffer in
            event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: buffer.baseAddress!)
            up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: buffer.baseAddress!)
        }
    }
    // Delete separately so an empty fill clears the field as well.
    key(51)
    if !units.isEmpty { event.postToPid(pid); up.postToPid(pid) }
    output(true)
case "enter":
    press(unique(matches(arg(0))))
    key(36)
    output(true)
case "select":
    let select = unique(matches(arg(0)))
    press(select)
    Thread.sleep(forTimeInterval: 0.2)
    let options = nodes(app).filter { string($0, "AXRole") == "AXMenuItem" && text($0) == arg(1) }
    let option = unique(options)
    guard AXUIElementPerformAction(option, kAXPressAction as CFString) == .success else { fail("native option selection failed; value must match its accessible label") }
    output(true)
case "close-window":
    func closeVisibleWindow() {
        let window = appWindow()
        guard let button = attribute(window, "AXCloseButton"), CFGetTypeID(button) == AXUIElementGetTypeID(),
              AXUIElementPerformAction(button as! AXUIElement, kAXPressAction as CFString) == .success else { fail("native window close failed") }
    }
    closeVisibleWindow()
    Thread.sleep(forTimeInterval: 1)
    // The first close explains tray custody and leaves the window open.
    if windowVisible() { closeVisibleWindow() }
    let deadline = Date().addingTimeInterval(10)
    while windowVisible() && Date() < deadline { Thread.sleep(forTimeInterval: 0.1) }
    guard !windowVisible() else { fail("native close did not hide the owned window") }
    output(["pid": pid, "visible": false])
case "settings-back":
    let (heading, back) = settingsControls()
    let observedTitle = text(heading)
    let observedLabel = text(back)
    press(back)
    let deadline = Date().addingTimeInterval(10)
    var returned = false
    repeat {
        guard !running.isTerminated else { fail("owned app exited during Back") }
        _ = appWindow()
        let settings = matches("settings-title")
        let connection = matches("connection-title")
        guard settings.count <= 1, connection.count <= 1 else { fail("ambiguous heading after Back") }
        returned = !(settings.first.map(visible) ?? false) && (connection.first.map(visible) ?? false)
        if !returned { Thread.sleep(forTimeInterval: 0.1) }
    } while !returned && Date() < deadline
    guard returned else { fail("Back did not hide Settings and reveal the owned connection view") }
    output(["pid": pid, "visible": windowVisible(), "title": observedTitle, "label": observedLabel])
case "settings", "quit":
    // The app owns a status-menu extra. Open it by its native bounds, then use the actual menu item.
    let bars = attribute(app, "AXExtrasMenuBar").map { [$0 as! AXUIElement] } ?? []
    guard bars.count == 1 else { fail("owned app has no extras menu bar") }
    let extras = children(bars[0]).filter { string($0, "AXRole") == "AXMenuBarItem" }
    press(unique(extras))
    Thread.sleep(forTimeInterval: 0.2)
    let item = unique(nodes(bars[0]).filter { string($0, "AXRole") == "AXMenuItem" && string($0, "AXTitle") == (operation == "settings" ? "Settings…" : "Quit app (computer stays connected)") })
    guard AXUIElementPerformAction(item, kAXPressAction as CFString) == .success else { fail("native menu action failed") }
    output(["pid": pid, "visible": windowVisible()])
case "screenshot":
    let window = appWindow()
    guard let rect = bounds(window) else { fail("selected window has no capture bounds") }
    let capture = Process()
    capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    capture.arguments = ["-x", "-R", "\(Int(rect.minX)),\(Int(rect.minY)),\(Int(rect.width)),\(Int(rect.height))", arg(0)]
    do { try capture.run() } catch { fail("cannot start window capture: \(error)") }
    capture.waitUntilExit()
    guard capture.terminationStatus == 0 else { fail("window capture failed; Screen Recording permission may be required") }
    output(true)
case "login-entry":
    guard let home = ProcessInfo.processInfo.environment["HOME"], let executable = running.executableURL else { fail("missing home or executable path") }
    let directory = URL(fileURLWithPath: home).appendingPathComponent("Library/LaunchAgents")
    let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
    let candidates = files.filter { $0.pathExtension == "plist" && $0.lastPathComponent.lowercased().contains("cotal") }.filter { url in
        guard let data = try? Data(contentsOf: url),
              let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              let arguments = plist["ProgramArguments"] as? [String] else { return false }
        return arguments.first.map { URL(fileURLWithPath: $0).resolvingSymlinksInPath() == executable.resolvingSymlinksInPath() } ?? false
    }
    guard candidates.count == 1 else { fail("expected one login entry for the exact owned executable, found \(candidates.count)") }
    let data = try Data(contentsOf: candidates[0])
    let plist = try PropertyListSerialization.propertyList(from: data, format: nil) as! [String: Any]
    guard let arguments = plist["ProgramArguments"] as? [String], arguments == [executable.path, "--background"] else { fail("owned login entry must contain only executable and --background") }
    output(["pid": pid, "visible": windowVisible(), "path": executable.path, "args": Array(arguments.dropFirst()), "source": candidates[0].path])
case "disable-login":
    guard let home = ProcessInfo.processInfo.environment["HOME"], let executable = running.executableURL else { fail("missing private home or executable") }
    let directory = URL(fileURLWithPath: home).appendingPathComponent("Library/LaunchAgents")
    let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
    let sources = files.filter { $0.pathExtension == "plist" && $0.lastPathComponent.lowercased().contains("cotal") }.filter { url in
        guard let data = try? Data(contentsOf: url),
              let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              let arguments = plist["ProgramArguments"] as? [String] else { return false }
        return arguments == [executable.path, "--background"]
    }
    guard sources.count <= 1 else { fail("ambiguous owned app login entry") }
    let initial = loginCheckboxState()
    loginReceipt("before-single-toggle", loginDiagnosticContext ?? [:])
    if initial.value == 1 { press(initial.element) }
    loginReceipt("after-single-toggle-input", ["pid": pid, "initialAXValue": initial.value, "inputCount": initial.value == 1 ? 1 : 0])
    var deadline = Date().addingTimeInterval(10)
    var unchecked = false
    repeat {
        // A render may replace the AX object after the one native toggle.
        let observation = loginCheckboxState()
        unchecked = observation.value == 0
        if !unchecked { Thread.sleep(forTimeInterval: 0.1) }
    } while !unchecked && Date() < deadline
    loginReceipt("after-single-toggle-observation", loginDiagnosticContext ?? [:])
    if !unchecked {
        _ = focusReceipt("no-change", appWindow())
        loginReceipt("initial-delivery-failure", ["pid": pid, "AXValue": 1, "firstPostUnixMs": firstLoginPost])
        _ = receiptPolicy("check", loginCursor, String(firstLoginPost))
        loginDelivery = "redelivery-1"
        let current = loginCheckboxState()
        guard current.value == 1 else { fail("login state changed before redelivery") }
        press(current.element)
        deadline = Date().addingTimeInterval(10)
        repeat {
            let observation = loginCheckboxState()
            unchecked = observation.value == 0
            if !unchecked { Thread.sleep(forTimeInterval: 0.1) }
        } while !unchecked && Date() < deadline
        loginReceipt("after-redelivery-observation", loginDiagnosticContext ?? [:])
        if !unchecked { _ = focusReceipt("no-change", appWindow()) }
    }
    guard unchecked else { fail("Open at login unchecked observation timed out after redelivery-1") }
    while sources.contains(where: { FileManager.default.fileExists(atPath: $0.path) }) && Date() < deadline { Thread.sleep(forTimeInterval: 0.1) }
    guard !sources.contains(where: { FileManager.default.fileExists(atPath: $0.path) }) else { fail("native login entry remains after preference change") }
    output(["pid": pid, "visible": windowVisible()])
default: fail("unsupported operation \(operation)")
}
