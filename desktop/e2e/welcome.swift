import Foundation
import Vision
import ImageIO

let url = URL(fileURLWithPath: CommandLine.arguments[1])
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
try VNImageRequestHandler(url: url).perform([request])
let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ").lowercased()
guard text.contains("welcome to cotal"), text.contains("continue"), text.contains("host") else {
    fputs("Installed app screenshot does not show the first-run screen: \(text)\n", stderr)
    exit(1)
}
guard !text.contains("operation did not complete"), !text.contains("reading computer information") else {
    fputs("Installed app first screen reports a startup refusal: \(text)\n", stderr)
    exit(1)
}
print("Vision confirmed the installed app welcome and sign-in controls")
