import 'dart:convert';
import 'dart:io';

/// Returns the files under [srcDir] that changed since the last call, and
/// records the current state in [manifest] (a JSON file) for next time.
List<String> changedFiles(Directory srcDir, File manifest) {
  final Map<String, dynamic> seen = manifest.existsSync()
      ? jsonDecode(manifest.readAsStringSync()) as Map<String, dynamic>
      : {};
  final changed = <String>[];
  final next = <String, int>{};
  for (final e in srcDir.listSync(recursive: true)) {
    if (e is! File) continue;
    final rel = e.path.substring(srcDir.path.length + 1);
    // Store and compare at the full precision the file system reports
    // (microseconds), so a round trip through the manifest is exact.
    final modified = e.lastModifiedSync().microsecondsSinceEpoch;
    final prev = seen[rel] as int?;
    if (prev == null || modified != prev) {
      changed.add(rel);
    }
    next[rel] = modified;
  }
  manifest.writeAsStringSync(jsonEncode(next));
  changed.sort();
  return changed;
}
