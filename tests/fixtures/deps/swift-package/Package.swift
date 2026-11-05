// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "AcmeKit",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(url: "https://github.com/apple/swift-argument-parser.git", from: "1.3.0"),
        .package(url: "https://github.com/pointfreeco/swift-snapshot-testing", exact: "1.17.5"),
        // .package(url: "https://github.com/commented/out.git", from: "1.0.0"),
        .package(path: "../LocalKit"),
    ],
    targets: [
        .executableTarget(name: "acme", dependencies: [
            .product(name: "ArgumentParser", package: "swift-argument-parser"),
        ]),
    ]
)
