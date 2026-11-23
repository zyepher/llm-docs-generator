/// Sends every chunk in order, then closes the connection. The connection is
/// closed whether the upload succeeds, fails, or the task is cancelled.
func upload(_ chunks: [String], over connection: Connection) async throws {
    do {
        for chunk in chunks {
            try await connection.send(chunk)
        }
    } catch {
        await connection.close()
        throw error
    }
    await connection.close()
}
