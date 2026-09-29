plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }
android {
    namespace = "example.consumer"
    compileSdk = 35
    defaultConfig { applicationId = "example.consumer"; minSdk = 26; targetSdk = 35; versionCode = 1; versionName = "1.0" }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    testOptions { unitTests.isReturnDefaultValues = true }
}
kotlin { jvmToolchain(17) }
dependencies {
    implementation(project(":logger-api"))
    debugImplementation(project(":logger"))
    testImplementation("junit:junit:4.13.2")
    testDebugImplementation("org.json:json:20240303")
}
tasks.register("verifyReleaseDependencies") {
    doLast {
        val components = configurations.getByName("releaseRuntimeClasspath").incoming.resolutionResult.allComponents
        check(components.none { component ->
            val id = component.id
            id is org.gradle.api.artifacts.component.ProjectComponentIdentifier && id.projectPath == ":logger"
        }) { "Debug recorder present in releaseRuntimeClasspath" }
        val report = layout.buildDirectory.file("reports/release-dependencies.txt").get().asFile
        report.parentFile.mkdirs()
        report.writeText(components.map { it.id.displayName }.sorted().joinToString("\n", postfix = "\n"))
    }
}
