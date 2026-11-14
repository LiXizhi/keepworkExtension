// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "AIPetCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "AIPetCore", targets: ["AIPetCore"]),
               .executable(name: "AIPetCoreChecks", targets: ["AIPetCoreChecks"])],
    targets: [
        .target(name: "AIPetCore"),
        .executableTarget(name: "AIPetCoreChecks", dependencies: ["AIPetCore"], path: "Tests/AIPetCoreTests")
    ]
)
