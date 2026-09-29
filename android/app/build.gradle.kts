plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }
android {
    namespace = "dev.networklog.app"
    compileSdk = 35
    defaultConfig { minSdk = 26; applicationId = "dev.networklog.sample"; versionCode = 1; versionName = "0.1.0"; targetSdk = 35
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    buildTypes {
        release {
            isDebuggable = false
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
        // Inspection fixture: same production code/dependencies without optimizer assistance.
        create("releaseUnminified") {
            initWith(getByName("release"))
            isMinifyEnabled = false
            isShrinkResources = false
            matchingFallbacks += "release"
        }
    }
    sourceSets.getByName("releaseUnminified").java.srcDir("src/release/kotlin")
    testOptions { unitTests.isReturnDefaultValues = true }
}
kotlin { jvmToolchain(17) }
dependencies {
    implementation(project(":logger-api")); debugImplementation(project(":logger")); implementation(project(":demo-auth")); androidTestImplementation("androidx.test:runner:1.6.2"); androidTestImplementation("androidx.test.ext:junit:1.2.1")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}

// A negative verification probe used by scripts/verify-release.sh; not a production dependency.
if (providers.gradleProperty("networklogLeakProbe").isPresent) {
    dependencies.add("releaseImplementation", project(":logger"))
}

tasks.register("verifyReleaseDependencies") {
    doLast {
        val report = linkedMapOf<String, List<String>>()
        for (name in listOf("releaseRuntimeClasspath", "releaseUnminifiedRuntimeClasspath")) {
            val dependencies = configurations.getByName(name).incoming.resolutionResult.allComponents
            check(dependencies.none { it.id is org.gradle.api.artifacts.component.ProjectComponentIdentifier &&
                (it.id as org.gradle.api.artifacts.component.ProjectComponentIdentifier).projectPath == ":logger" }) {
                "Production must never resolve the debug recorder: $name"
            }
            report[name] = dependencies.map { it.id.displayName }.sorted()
            println("$name: " + report.getValue(name).joinToString(", "))
        }
        val target = layout.buildDirectory.file("reports/networklog-release-dependencies.json").get().asFile
        target.parentFile.mkdirs()
        target.writeText(groovy.json.JsonOutput.prettyPrint(groovy.json.JsonOutput.toJson(report)))
    }
}
