import AppKit
import ApplicationServices
import Darwin

// Native AX/CG observation patterned after desktop/e2e/macos-driver.swift at ea03532fe4.
func fail(_ text: String) -> Never { fputs("updater proof: \(text)\n", stderr); exit(1) }
func output(_ value: Any) { let bytes = try! JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]); print(String(data: bytes, encoding: .utf8)!) }
guard CommandLine.arguments.count >= 3 else { fail("expected app path and operation") }
let path = URL(fileURLWithPath: CommandLine.arguments[1]).standardizedFileURL.path
let operation = CommandLine.arguments[2]
let candidates = NSRunningApplication.runningApplications(withBundleIdentifier: "ai.cotal.desktop").filter { $0.bundleURL?.standardizedFileURL.path == path && !$0.isTerminated }
guard candidates.count == 1 else { fail("expected one running owned app, found \(candidates.count)") }
let running = candidates[0]
let pid = running.processIdentifier
let app = AXUIElementCreateApplication(pid)
AXUIElementSetMessagingTimeout(app, 5)
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? { var value: CFTypeRef?; return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil }
func text(_ element: AXUIElement) -> String { (attribute(element, "AXValue") as? String) ?? (attribute(element, "AXTitle") as? String) ?? "" }
func nodes(_ element: AXUIElement, _ depth: Int = 0) -> [AXUIElement] {
    guard depth < 40 else { fail("AX depth exceeded") }
    return [element] + ((attribute(element, "AXChildren") as? [AXUIElement]) ?? []).flatMap { nodes($0, depth + 1) }
}
func visible() -> Bool {
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as! [[String: Any]]
    return windows.contains { ($0[kCGWindowOwnerPID as String] as? pid_t) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }
}
func element(_ id: String) -> AXUIElement {
    guard AXIsProcessTrusted() else { fail("Accessibility permission is required") }
    let matches = nodes(app).filter { (attribute($0, "AXDOMIdentifier") as? String) == id }
    guard matches.count == 1 else { fail("expected unique DOM id \(id), found \(matches.count)") }
    return matches[0]
}
func press(_ element: AXUIElement) {
    guard attribute(element, "AXEnabled") as? Bool == true else { fail("control is not enabled") }
    guard AXUIElementPerformAction(element, kAXPressAction as CFString) == .success else { fail("AX press failed") }
}
switch operation {
case "describe": output(["pid": pid, "visible": visible(), "path": path, "activation": running.activationPolicy.rawValue])
case "text":
    guard CommandLine.arguments.count == 4 else { fail("missing DOM id") }
    output(text(element(CommandLine.arguments[3])))
case "click":
    guard CommandLine.arguments.count == 4 else { fail("missing DOM id") }
    press(element(CommandLine.arguments[3])); output(true)
case "close":
    guard AXIsProcessTrusted() else { fail("Accessibility permission is required") }
    for _ in 0..<2 {
        if !visible() { break }
        let windows = attribute(app, "AXWindows") as? [AXUIElement] ?? []
        guard windows.count == 1, let button = attribute(windows[0], "AXCloseButton"), CFGetTypeID(button) == AXUIElementGetTypeID() else { fail("no unique owned close button") }
        guard AXUIElementPerformAction(button as! AXUIElement, kAXPressAction as CFString) == .success else { fail("native close failed") }
        Thread.sleep(forTimeInterval: 1)
    }
    output(["pid": pid, "visible": visible()])
case "settings":
    guard AXIsProcessTrusted() else { fail("Accessibility permission is required") }
    let bars = attribute(app, "AXExtrasMenuBar").map { [$0 as! AXUIElement] } ?? []
    guard bars.count == 1 else { fail("no unique extras bar") }
    let extras = nodes(bars[0]).filter { attribute($0, "AXRole") as? String == "AXMenuBarItem" }
    guard extras.count == 1 else { fail("no unique status item") }
    press(extras[0]); Thread.sleep(forTimeInterval: 0.2)
    let items = nodes(bars[0]).filter { attribute($0, "AXRole") as? String == "AXMenuItem" && text($0) == "Settings…" }
    guard items.count == 1 else { fail("no unique Settings menu") }
    press(items[0]); output(true)
case "quit": guard running.terminate() else { fail("native terminate request refused") }; output(true)
case "dump":
    output(["pid": pid, "nodes": nodes(app).map { ["id": attribute($0, "AXDOMIdentifier") as? String ?? "", "text": text($0), "role": attribute($0, "AXRole") as? String ?? ""] }])
default: fail("unsupported operation")
}
