// swift-tools-version: 6.4
import PackageDescription

let package = Package(
    name: "Transfer",
    platforms: [.macOS("27.0")],
    products: [
        .library(name: "Transfer", targets: ["Transfer"]),
    ],
    targets: [
        .target(name: "Transfer"),
    ]
)
