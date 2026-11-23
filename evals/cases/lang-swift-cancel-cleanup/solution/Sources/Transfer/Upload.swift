/// Sends every chunk in order, then closes the connection. The connection is
/// closed whether the upload succeeds, fails, or the task is cancelled.
func upload(_ chunks: [String], over connection: Connection) async throws {
    defer {
        // Run the async close even if this task has been cancelled.
        await withTaskCancellationShield {
            await connection.close()
        }
    }
    for chunk in chunks {
        try await connection.send(chunk)
    }
}
