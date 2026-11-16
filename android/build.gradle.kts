plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.ktlint) apply false
}

// Clean code review V3, decision D1: ktlint checks and formats Kotlin in every module
// (`./gradlew ktlintCheck`, `./gradlew ktlintFormat`). Rules come from the repository's .editorconfig.
val ktlintVersion = libs.versions.ktlint.get()

subprojects {
    apply(plugin = "org.jlleitschuh.gradle.ktlint")
    extensions.configure<org.jlleitschuh.gradle.ktlint.KtlintExtension> {
        version.set(ktlintVersion)
    }
}
