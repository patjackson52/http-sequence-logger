pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories { google(); mavenCentral() }
}
rootProject.name = "ExternalLoggerConsumer"
include(":app", ":logger-api", ":logger")
// Same source-install recipe as an existing application: do not import the sample build.
val loggerCheckout = file("../..")
project(":logger-api").projectDir = File(loggerCheckout, "android/logger-api")
project(":logger").projectDir = File(loggerCheckout, "android/logger")
