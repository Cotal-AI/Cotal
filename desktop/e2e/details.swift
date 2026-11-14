import Foundation
import ApplicationServices

let pid = pid_t(CommandLine.arguments[1])!
let app = AXUIElementCreateApplication(pid)
let inspectOnly = CommandLine.arguments.contains("--inspect")
func attribute(_ element: AXUIElement, _ name: CFString) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name, &value) == .success ? value : nil
}
var pressed = false
var refusal = ""
func click(_ element: AXUIElement) {
    guard let p = attribute(element, kAXPositionAttribute as CFString), let s = attribute(element, kAXSizeAttribute as CFString) else { return }
    var point = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &size) else { return }
    let center = CGPoint(x: point.x + size.width / 2, y: point.y + size.height / 2)
    CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: center, mouseButton: .left)?.post(tap: .cghidEventTap)
    CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: center, mouseButton: .left)?.post(tap: .cghidEventTap)
    pressed = true
}
func walk(_ element: AXUIElement, _ depth: Int) {
    if depth > 24 { return }
    let identifier = attribute(element, "AXDOMIdentifier" as CFString) as? String ?? attribute(element, kAXIdentifierAttribute as CFString) as? String ?? ""
    let role = attribute(element, kAXRoleAttribute as CFString) as? String ?? ""
    let title = attribute(element, kAXTitleAttribute as CFString) as? String ?? ""
    let description = attribute(element, kAXDescriptionAttribute as CFString) as? String ?? ""
    let value = attribute(element, kAXValueAttribute as CFString) as? String ?? ""
    print("\(depth) \(role) id=\(identifier) title=\(title) description=\(description) value=\(value)")
    if !inspectOnly && !pressed && identifier == "details" {
        // Select the disclosure by its owning stable DOM ID, then click its native bounds.
        let children = attribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement] ?? []
        if let triangle = children.first { click(triangle) }
    }
    if identifier == "refusal-detail" {
        func contents(_ node: AXUIElement) -> String {
            let own = [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute].compactMap { attribute(node, $0 as CFString) as? String }.joined(separator: " ")
            return own + ((attribute(node, kAXChildrenAttribute as CFString) as? [AXUIElement] ?? []).map(contents).joined(separator: " "))
        }
        refusal += contents(element)
    }
    let children = attribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement] ?? []
    for child in children { walk(child, depth + 1) }
}
walk(app, 0)
Thread.sleep(forTimeInterval: 0.8)
walk(app, 0)
if !inspectOnly && refusal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
    fputs("Details did not expose the exact refusal text\n", stderr)
    exit(1)
}
