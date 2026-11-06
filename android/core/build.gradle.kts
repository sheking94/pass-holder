plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
    `java-test-fixtures`
}

// Plain Kotlin/JVM, no Android: crypto, sync and the server client run in fast JVM unit tests.
java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}

dependencies {
    api(libs.kotlinx.serialization.json)
    api(libs.okhttp)
    implementation(libs.bouncycastle)

    // FakeServer: the server API on MockWebServer, shared by the core tests and the app's screen tests.
    testFixturesApi(libs.okhttp.mockwebserver)

    testImplementation(platform(libs.junit.bom))
    testImplementation(libs.junit.jupiter)
    testImplementation(libs.okhttp.tls)
    testRuntimeOnly(libs.junit.platform.launcher)
}

tasks.test {
    useJUnitPlatform()
    // The shared test vectors live in the TypeScript core, one level above android/.
    systemProperty("passholder.repoRoot", rootDir.parentFile.absolutePath)
    // Opt-in test against the real Node.js server: PASSHOLDER_SERVER_TEST=1 ./gradlew :core:test
    environment("PASSHOLDER_SERVER_TEST", System.getenv("PASSHOLDER_SERVER_TEST") ?: "")
    // Opt-in interop test with the TypeScript extension client: PASSHOLDER_INTEROP_TEST=1
    environment("PASSHOLDER_INTEROP_TEST", System.getenv("PASSHOLDER_INTEROP_TEST") ?: "")
    testLogging { events("passed", "skipped", "failed") }
}
