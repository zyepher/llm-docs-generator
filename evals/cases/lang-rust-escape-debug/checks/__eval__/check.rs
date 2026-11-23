// Hidden behavioural check: rustc --edition 2024 check.rs (candidate copied to logfmt.rs).
#[path = "logfmt.rs"]
mod logfmt;

fn main() {
    let cases = [
        ("user", "ana", "user=\"ana\""),
        ("msg", "say \"hi\"\nbye", "msg=\"say \\\"hi\\\"\\nbye\""),
        ("path", "C:\\tmp", "path=\"C:\\\\tmp\""),
        ("name", "Zoe\u{308}", "name=\"Zoe\u{308}\""),          // decomposed e-umlaut
        ("city", "\u{915}\u{94d}\u{937}\u{93f}", "city=\"\u{915}\u{94d}\u{937}\u{93f}\""), // Devanagari with virama
        ("bell", "a\u{7}b", "bell=\"a\\u{7}b\""),
    ];
    let mut failures = 0;
    for (k, v, want) in cases {
        let got = logfmt::field(k, v);
        if got != want {
            println!("FAIL {k}: got {got} want {want}");
            failures += 1;
        }
    }
    println!("{}", if failures == 0 { "PASS".to_string() } else { format!("{failures} FAILED") });
    std::process::exit(if failures == 0 { 0 } else { 1 });
}
