// swift-tools-version: 6.0
import PackageDescription

// This is an external development consumer, not a second capture SDK.
let package = Package(
    name: "DevelopmentConsumer",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [.library(name: "DevelopmentDelivery", targets: ["DevelopmentDelivery"])],
    dependencies: [.package(path: "../../ios")],
    targets: [
        .target(name: "AppLogging", path: "Production/Sources/AppLogging"),
        .target(name: "DevelopmentDelivery", dependencies: [
            "AppLogging", .product(name: "NetworkLogTransfer", package: "ios")
        ]),
        .testTarget(name: "DevelopmentDeliveryTests", dependencies: ["DevelopmentDelivery", "AppLogging"])
    ]
)
