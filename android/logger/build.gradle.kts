plugins { id("com.android.library"); id("org.jetbrains.kotlin.android") }
android {
    namespace = "dev.networklog.logger"
    compileSdk = 35
    defaultConfig { minSdk = 26;
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    testOptions { unitTests.isReturnDefaultValues = true }
}
kotlin { jvmToolchain(17) }
dependencies {
    api(project(":logger-api"))

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}

// A development-only artifact: accidental release dependencies fail variant resolution.
androidComponents { beforeVariants(selector().withBuildType("release")) { it.enable = false } }
