import SwiftUI

/// A production host deliberately has no capture or transfer dependency.
/// Real applications put their own screens here and keep development tools in a separate target.
@main struct ProductionApp: App {
    var body: some Scene {
        WindowGroup { Text("Sample application") }
    }
}
