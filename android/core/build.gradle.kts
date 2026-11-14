plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
    `java-test-fixtures`
}

// Plain Kotlin/JVM, no Android: crypto and the phone's P2P sync host run in fast JVM unit tests.
java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}

dependencies {
    api(libs.kotlinx.serialization.json)
    implementation(libs.bouncycastle)

    testImplementation(platform(libs.junit.bom))
    testImplementation(libs.junit.jupiter)
    // P2pInteropTest: the Kotlin host behind MockWebServer, for the extension's client running in Node.js.
    testImplementation(libs.okhttp.mockwebserver)
    testRuntimeOnly(libs.junit.platform.launcher)
}

tasks.test {
    useJUnitPlatform()
    // The shared test vectors live in the TypeScript core, one level above android/.
    systemProperty("passholder.repoRoot", rootDir.parentFile.absolutePath)
    // Tests that write shared fixtures do so only with -Dpassholder.writeFixtures=true.
    systemProperty("passholder.writeFixtures", System.getProperty("passholder.writeFixtures") ?: "")
    // Opt-in interop test with the TypeScript extension client: PASSHOLDER_INTEROP_TEST=1
    environment("PASSHOLDER_INTEROP_TEST", System.getenv("PASSHOLDER_INTEROP_TEST") ?: "")
    testLogging { events("passed", "skipped", "failed") }
}
