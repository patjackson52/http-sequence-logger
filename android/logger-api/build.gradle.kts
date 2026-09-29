plugins { id("org.jetbrains.kotlin.jvm"); `java-library` }
kotlin {
    jvmToolchain(17)
    compilerOptions { jvmDefault.set(org.jetbrains.kotlin.gradle.dsl.JvmDefaultMode.NO_COMPATIBILITY) }
}
dependencies { testImplementation("junit:junit:4.13.2") }
