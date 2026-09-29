// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "NetworkLogTransfer",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [.library(name: "NetworkLogTransfer", targets: ["NetworkLogTransfer"])],
    targets: [
        .target(name: "NetworkLogTransfer"),
        .testTarget(name: "NetworkLogTransferTests", dependencies: ["NetworkLogTransfer"], resources: [.copy("Fixtures")])
    ]
)
