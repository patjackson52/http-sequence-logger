pluginManagement {
    repositories {
        // Shipyard Deploy's plugin is installed locally from its pinned source checkout.
        mavenLocal {
            content {
                includeGroup("works.sloop.shipyard")
                includeGroup("works.sloop.shipyard.deploy")
            }
        }
        google(); mavenCentral(); gradlePluginPortal()
    }
}
dependencyResolutionManagement { repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS); repositories { google(); mavenCentral() } }
rootProject.name = "NetworkLogLab"
include(":logger-api", ":logger", ":demo-auth", ":app")
