// Hidden behavioural check. Copy the candidate to sync.dart next to this file
// (or pass nothing: the runner script does the copy), then: dart run check.dart
import 'dart:io';
import 'sync.dart';

void main() {
  final root = Directory.systemTemp.createTempSync('mtime_check_');
  final src = Directory('${root.path}/src')..createSync();
  final manifest = File('${root.path}/manifest.json');
  var failures = 0;
  void expect(Object? got, Object? want, String what) {
    if (got.toString() != want.toString()) {
      print('FAIL $what: got $got want $want');
      failures++;
    }
  }

  File('${src.path}/a.txt').writeAsStringSync('a');
  File('${src.path}/b.txt').writeAsStringSync('b');
  expect(changedFiles(src, manifest), ['a.txt', 'b.txt'], 'first run');
  expect(changedFiles(src, manifest), [], 'second run, nothing touched');
  sleep(const Duration(milliseconds: 20));
  File('${src.path}/b.txt').writeAsStringSync('b2');
  expect(changedFiles(src, manifest), ['b.txt'], 'after editing b.txt');
  expect(changedFiles(src, manifest), [], 'run after that');

  root.deleteSync(recursive: true);
  print(failures == 0 ? 'PASS' : '$failures FAILED');
  exit(failures == 0 ? 0 : 1);
}
