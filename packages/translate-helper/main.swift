import Foundation
import Translation

private struct TranslationBatchRequest: Decodable {
    let id: String
    let texts: [String]
}

private struct TranslationItemResult: Encodable {
    let ok: Bool
    let text: String?
    let error: String?

    static func success(text: String) -> TranslationItemResult {
        TranslationItemResult(ok: true, text: text, error: nil)
    }

    static func failure(error: String) -> TranslationItemResult {
        TranslationItemResult(ok: false, text: nil, error: error)
    }
}

private struct TranslationBatchResponse: Encodable {
    let id: String
    let results: [TranslationItemResult]
}

@main
struct TranslationHelper {
    private static let decoder = JSONDecoder()
    private static let encoder = JSONEncoder()

    static func main() async {
        let session = TranslationSession(
            installedSource: Locale.Language(identifier: "en"),
            target: Locale.Language(identifier: "ja")
        )
        var prepared = false

        // The readLine loop processes requests serially — one `await
        // session.translations(from:)` completes before the next line is read.
        // This is intentional: measured 2026-07-19
        // (docs/findings/2026-07-19-translate-helper-parallelism.md) that a
        // Task-parallel dispatch (either on one session or a session pool of
        // 2/4/8) leaves the N=16 total unchanged (~11.2s in every strategy)
        // and pushes first-response latency from 302ms up to 726ms — because
        // Translation.framework serializes at the process/device level. Adding
        // a TaskGroup/Actor here would only add complexity and hurt UX.
        while let line = readLine() {
            guard let data = line.data(using: .utf8) else {
                write(TranslationBatchResponse(id: "", results: []))
                continue
            }

            let request: TranslationBatchRequest
            do {
                request = try decoder.decode(TranslationBatchRequest.self, from: data)
            } catch {
                write(TranslationBatchResponse(id: requestId(from: data), results: []))
                continue
            }

            if request.texts.isEmpty {
                write(TranslationBatchResponse(id: request.id, results: []))
                continue
            }

            do {
                if !prepared {
                    try await session.prepareTranslation()
                    prepared = true
                }
                // Batch translation (issue 2026-07-17 #2a): 1 session call for
                // the whole line's texts instead of one `translate(_:)` call
                // per item. On this warm persistent process the two are nearly
                // tied (measured 2026-07-17: 10-item batch 12.7s vs 12.9s
                // sequential); the batch wire shape's real payoff is letting
                // the daemon fold N webui requests into one line (issue #2b).
                // clientIdentifier carries the original index so the response
                // can be re-ordered even though the framework docs only claim
                // (not guarantee at the type level) request-order responses.
                let requests = request.texts.enumerated().map { index, text in
                    TranslationSession.Request(sourceText: text, clientIdentifier: String(index))
                }
                let responses = try await session.translations(from: requests)
                var byIndex: [String: String] = [:]
                for response in responses {
                    if let id = response.clientIdentifier {
                        byIndex[id] = response.targetText
                    }
                }
                let results = (0..<request.texts.count).map { index -> TranslationItemResult in
                    if let text = byIndex[String(index)] {
                        return .success(text: text)
                    }
                    return .failure(error: "translation helper returned no result for item \(index)")
                }
                write(TranslationBatchResponse(id: request.id, results: results))
            } catch {
                // TranslationError.notInstalled is intentionally preserved in
                // String(describing:) so the daemon can return the OS error
                // as-is. A batch-level failure (e.g. model missing) fails
                // every item in the batch identically — translations(from:)
                // has no per-item error channel.
                let message = String(describing: error)
                let results = request.texts.map { _ in TranslationItemResult.failure(error: message) }
                write(TranslationBatchResponse(id: request.id, results: results))
            }
        }
    }

    private static func requestId(from data: Data) -> String {
        guard
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let id = object["id"] as? String
        else {
            return ""
        }
        return id
    }

    private static func write(_ response: TranslationBatchResponse) {
        guard let data = try? encoder.encode(response) else {
            return
        }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    }
}
