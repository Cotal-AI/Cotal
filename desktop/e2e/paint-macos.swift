import Foundation
import CoreGraphics
import ImageIO
import Darwin

// Build before launching the application. No accessibility or app instrumentation is used.
let arguments = CommandLine.arguments
guard arguments.count == 4 else {
    fputs("usage: paint-macos <pidFile> <readyFile> <outputDir>\n", stderr)
    exit(2)
}
let pidURL = URL(fileURLWithPath: arguments[1])
let readyURL = URL(fileURLWithPath: arguments[2])
let outputURL = URL(fileURLWithPath: arguments[3], isDirectory: true)
let started = ProcessInfo.processInfo.systemUptime
func milliseconds() -> Double { (ProcessInfo.processInfo.systemUptime - started) * 1000 }

var samples: [[String: Any]] = []
var visibleAt: Double?
var paintedAt: Double?
var processStartedAt: Date?
var firstVisibleAt: Date?
var anyFrameNeitherPaperNorContent = false
var firstNonpaperImage: CGImage?

func processStart(_ pid: pid_t) throws -> Date {
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
    let result = mib.withUnsafeMutableBufferPointer { buffer in
        sysctl(buffer.baseAddress, UInt32(buffer.count), &info, &size, nil, 0)
    }
    guard result == 0, size == MemoryLayout<kinfo_proc>.stride,
          info.kp_proc.p_starttime.tv_sec > 0 else {
        throw NSError(domain: "paint-macos", code: 6, userInfo: [NSLocalizedDescriptionKey: "Cannot read target process start time via KERN_PROC_PID (errno \(errno))"])
    }
    let time = info.kp_proc.p_starttime
    return Date(timeIntervalSince1970: Double(time.tv_sec) + Double(time.tv_usec) / 1_000_000)
}
var selectedID: CGWindowID?
var selectedBounds: CGRect?
var firstVisibleSaved = false
var firstVisibleImage: CGImage?
var captureCount = 0
var outcome = "timeout"
var failure: String?
let cadence = 0.020

func savePNG(_ image: CGImage, _ name: String) throws {
    let url = outputURL.appendingPathComponent(name)
    guard let destination = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else {
        throw NSError(domain: "paint-macos", code: 1, userInfo: [NSLocalizedDescriptionKey: "Cannot create \(name)"])
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else {
        throw NSError(domain: "paint-macos", code: 2, userInfo: [NSLocalizedDescriptionKey: "Cannot write \(name)"])
    }
}

func classifyHeader(_ image: CGImage, bounds: CGRect) throws -> (logoPixels: Int, paperFraction: Double) {
    // Window coordinates are points. Captures can have a Retina pixel scale.
    let sx = Double(image.width) / bounds.width
    let sy = Double(image.height) / bounds.height
    let crop = CGRect(x: 0, y: 30 * sy, width: min(180 * sx, Double(image.width)),
                      height: min(120 * sy, max(0, Double(image.height) - 30 * sy))).integral
    guard crop.width > 0, crop.height > 0, let header = image.cropping(to: crop) else {
        throw NSError(domain: "paint-macos", code: 7, userInfo: [NSLocalizedDescriptionKey: "Cannot crop header"])
    }
    let width = header.width
    let height = header.height
    var rgba = [UInt8](repeating: 0, count: width * height * 4)
    return try rgba.withUnsafeMutableBytes { storage in
        let info = CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue
        guard let context = CGContext(data: storage.baseAddress, width: width, height: height,
                                      bitsPerComponent: 8, bytesPerRow: width * 4,
                                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: info) else {
            throw NSError(domain: "paint-macos", code: 3, userInfo: [NSLocalizedDescriptionKey: "Cannot create RGBA context"])
        }
        context.draw(header, in: CGRect(x: 0, y: 0, width: width, height: height))
        let bytes = storage.bindMemory(to: UInt8.self)
        var count = 0
        var paperCount = 0
        for offset in stride(from: 0, to: bytes.count, by: 4) {
            let alpha = Int(bytes[offset + 3])
            guard alpha > 0 else { continue }
            let r = Int(bytes[offset]) * 255 / alpha
            let g = Int(bytes[offset + 1]) * 255 / alpha
            let b = Int(bytes[offset + 2]) * 255 / alpha
            let highest = max(r, max(g, b))
            let lowest = min(r, min(g, b))
            if highest - lowest > 60 && highest > 140 { count += 1 }
            // Paper is #fffcee. A tolerance of 5 keeps pure white distinct.
            if alpha == 255 && abs(r - 255) <= 5 && abs(g - 252) <= 5 && abs(b - 238) <= 5 {
                paperCount += 1
            }
        }
        return (count, Double(paperCount) / Double(width * height))
    }
}

do {
    try FileManager.default.createDirectory(at: outputURL, withIntermediateDirectories: true)
    try Data("ready\n".utf8).write(to: readyURL, options: .atomic)
    var pid: pid_t?
    while milliseconds() < 45_000 {
        let tick = ProcessInfo.processInfo.systemUptime
        if pid == nil, let data = try? String(contentsOf: pidURL, encoding: .utf8) {
            let text = data.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty, text.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }),
                  let value = Int32(text), value > 0 else {
                throw NSError(domain: "paint-macos", code: 4, userInfo: [NSLocalizedDescriptionKey: "pidFile must contain a positive decimal PID"])
            }
            processStartedAt = try processStart(value)
            pid = value
        }
        let listStart = milliseconds()
        var sample: [String: Any] = ["atMs": listStart, "captureCount": captureCount,
                                     "captureDurationMs": 0.0, "logoPixels": 0, "logoPresent": false,
                                     "paperFraction": NSNull(), "content": false]
        if let pid = pid {
            guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
                throw NSError(domain: "paint-macos", code: 5, userInfo: [NSLocalizedDescriptionKey: "Cannot enumerate on-screen windows"])
            }
            let owned = windows.filter {
                ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid &&
                ($0[kCGWindowLayer as String] as? NSNumber)?.intValue == 0 &&
                (($0[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1) > 0
            }
            sample["ownedRegularWindowCount"] = owned.count
            for window in owned {
                guard let rawBounds = window[kCGWindowBounds as String] as? [String: Any],
                      let bounds = CGRect(dictionaryRepresentation: rawBounds as CFDictionary),
                      bounds.width >= 400, bounds.height >= 300,
                      let number = window[kCGWindowNumber as String] as? NSNumber else { continue }
                let id = CGWindowID(number.uint32Value)
                if selectedID == nil {
                    selectedID = id
                    selectedBounds = bounds
                    visibleAt = milliseconds()
                    firstVisibleAt = Date()
                }
                guard id == selectedID else { continue }
                selectedBounds = bounds
                let before = milliseconds()
                let image = CGWindowListCreateImage(bounds, .optionIncludingWindow, id, .boundsIgnoreFraming)
                let after = milliseconds()
                captureCount += 1
                sample["windowID"] = id
                sample["captureStartMs"] = before
                sample["captureEndMs"] = after
                sample["captureDurationMs"] = after - before
                sample["captureCount"] = captureCount
                sample["captureAvailable"] = image != nil
                if let image = image {
                    let classification = try classifyHeader(image, bounds: bounds)
                    let count = classification.logoPixels
                    let content = count >= 8
                    sample["logoPixels"] = count
                    sample["logoPresent"] = content
                    sample["content"] = content
                    sample["paperFraction"] = classification.paperFraction
                    let neither = !content && classification.paperFraction < 0.9
                    sample["neitherPaperNorContent"] = neither
                    if neither {
                        anyFrameNeitherPaperNorContent = true
                        if firstNonpaperImage == nil { firstNonpaperImage = image }
                    }
                    if !firstVisibleSaved {
                        firstVisibleImage = image
                        firstVisibleSaved = true
                    }
                    if count >= 8 {
                        paintedAt = after
                        try savePNG(image, "first-painted.png")
                        outcome = "painted"
                    }
                }
                break
            }
        }
        sample["sampleEndMs"] = milliseconds()
        samples.append(sample)
        if paintedAt != nil { break }
        let remaining = cadence - (ProcessInfo.processInfo.systemUptime - tick)
        if remaining > 0 { Thread.sleep(forTimeInterval: remaining) }
    }
    if paintedAt == nil { failure = "No captured header logo within 45 seconds, including PID wait. Check window visibility and Screen Recording permission." }
} catch {
    outcome = "error"
    failure = error.localizedDescription
}

// Preserve diagnostic frames even when a later capture or classification fails.
do {
    if let image = firstVisibleImage { try savePNG(image, "first-visible.png") }
    if let image = firstNonpaperImage { try savePNG(image, "first-nonpaper.png") }
} catch {
    outcome = "error"
    failure = error.localizedDescription
}
let timestampFormatter = ISO8601DateFormatter()
timestampFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
var report: [String: Any] = [
    "platform": "macOS",
    "method": "On-screen PID-owned layer-0 window enumeration and CGWindowListCreateImage, boundsIgnoreFraming; explicit big-endian premultiplied-last RGBA header saturation scan",
    "precisionCaveat": "processStartToVisibleMs compares the target PID's kernel KERN_PROC_PID p_starttime (seconds plus microseconds) with Date() at first observed on-screen regular window >=400x300. This is wall-clock timing, subject to clock adjustments and observation latency, not a compositor presentation timestamp. UTC processStartedAt and firstVisibleAt strings have millisecond precision; the duration uses unrounded timestamps. visibleAtMs and paintedAtMs remain monotonic milliseconds since sampler startup. paintedAtMs is the end of the first capture with >=8 saturated header pixels (x0..<180,y30..<150 points). Paper fraction uses #fffcee with per-channel tolerance 5, excluding the titlebar; pure white is not paper. Content uses the colored-logo saturation heuristic, not semantic recognition. Uncaptured samples have null paperFraction and content false, and do not contribute to anyFrameNeitherPaperNorContent. Capture latency, scheduling, occlusion and permissions limit precision. Target cadence is 20ms, not a timing guarantee.",
    "targetCadenceMs": 20,
    "processStartedAt": processStartedAt.map { timestampFormatter.string(from: $0) as Any } ?? NSNull(),
    "firstVisibleAt": firstVisibleAt.map { timestampFormatter.string(from: $0) as Any } ?? NSNull(),
    "processStartToVisibleMs": firstVisibleAt.flatMap { visible in processStartedAt.map { visible.timeIntervalSince($0) * 1000 } }.map { $0 as Any } ?? NSNull(),
    "anyFrameNeitherPaperNorContent": anyFrameNeitherPaperNorContent,
    "visibleAtMs": visibleAt.map { $0 as Any } ?? NSNull(),
    "paintedAtMs": paintedAt.map { $0 as Any } ?? NSNull(),
    "visibleToPaintMs": (paintedAt.flatMap { painted in visibleAt.map { painted - $0 } }).map { $0 as Any } ?? NSNull(),
    "windowID": selectedID.map { $0 as Any } ?? NSNull(),
    "samples": samples,
    "outcome": outcome
]
if let bounds = selectedBounds {
    report["windowBounds"] = ["x": bounds.origin.x, "y": bounds.origin.y, "width": bounds.width, "height": bounds.height]
} else { report["windowBounds"] = NSNull() }
if let failure = failure { report["error"] = failure }
do {
    try FileManager.default.createDirectory(at: outputURL, withIntermediateDirectories: true)
    let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
    try data.write(to: outputURL.appendingPathComponent("first-paint.json"), options: .atomic)
} catch {
    fputs("Cannot write first-paint.json: \(error.localizedDescription)\n", stderr)
    exit(2)
}
exit(outcome == "painted" ? 0 : 1)
