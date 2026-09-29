// swift-tools-version: 6.0
import PackageDescription

// A separate dependency graph: no NetworkLogTransfer package, even in the manifest.
let package = Package(
    name: "ProductionConsumer",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [.executable(name: "ProductionSmoke", targets: ["ProductionSmoke"])],
    targets: [
        .target(name: "AppLogging"),
        .executableTarget(name: "ProductionSmoke", dependencies: ["AppLogging"]),
        .testTarget(name: "AppLoggingTests", dependencies: ["AppLogging"])
    ]
)
