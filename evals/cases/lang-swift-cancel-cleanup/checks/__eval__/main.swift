// Hidden behavioural check: compiled together with Connection.swift and the
// candidate Upload.swift.
import Foundation

var failures = 0
@MainActor func expect(_ ok: Bool, _ what: String) {
    if !ok { print("FAIL", what); failures += 1 }
}

let ok = Connection()
try? await upload(["a", "b", "c"], over: ok)
expect(await ok.received == ["a", "b", "c"], "all chunks sent")
expect(await !ok.isOpen, "closed after success")

let failing = Connection()
let threw = (try? await upload(["a", "bad", "c"], over: failing)) == nil
expect(threw, "error propagated")
expect(await !failing.isOpen, "closed after a send error")

let cancelled = Connection()
let task = Task { try await upload(["a", "b", "c", "d", "e"], over: cancelled) }
try await Task.sleep(for: .milliseconds(30))
task.cancel()
_ = await task.result
expect(await !cancelled.isOpen, "closed after the task was cancelled")

print(failures == 0 ? "PASS" : "\(failures) FAILED")
exit(failures == 0 ? 0 : 1)
