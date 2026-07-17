import Foundation
import Translation

private struct TranslationRequest: Decodable {
    let id: String
    let text: String
}

private struct TranslationResponse: Encodable {
    let id: String
    let ok: Bool
    let text: String?
    let error: String?

    static func success(id: String, text: String) -> TranslationResponse {
        TranslationResponse(id: id, ok: true, text: text, error: nil)
    }

    static func failure(id: String, error: String) -> TranslationResponse {
        TranslationResponse(id: id, ok: false, text: nil, error: error)
    }
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

        while let line = readLine() {
            guard let data = line.data(using: .utf8) else {
                write(.failure(id: "", error: "request is not UTF-8"))
                continue
            }

            let request: TranslationRequest
            do {
                request = try decoder.decode(TranslationRequest.self, from: data)
            } catch {
                write(.failure(id: requestId(from: data), error: String(describing: error)))
                continue
            }

            do {
                if !prepared {
                    try await session.prepareTranslation()
                    prepared = true
                }
                let response = try await session.translate(request.text)
                write(.success(id: request.id, text: response.targetText))
            } catch {
                // TranslationError.notInstalled is intentionally preserved in
                // String(describing:) so the daemon can return the OS error as-is.
                write(.failure(id: request.id, error: String(describing: error)))
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

    private static func write(_ response: TranslationResponse) {
        guard let data = try? encoder.encode(response) else {
            return
        }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    }
}
