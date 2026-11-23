struct SendError: Error {}

actor Connection {
    private(set) var isOpen = true
    private(set) var received: [String] = []

    func send(_ chunk: String) async throws {
        try await Task.sleep(for: .milliseconds(20)) // network round trip
        if chunk == "bad" { throw SendError() }
        received.append(chunk)
    }

    /// Says goodbye to the server, then releases the connection.
    /// Like most network calls it gives up if the current task is cancelled.
    func close() async {
        do {
            try await Task.sleep(for: .milliseconds(5)) // goodbye round trip
        } catch {
            return
        }
        isOpen = false
    }
}
