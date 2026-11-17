package io.github.sheking94.passholder.core.transfer

import io.github.sheking94.passholder.core.p2p.EntryCodec
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File

internal fun readVector(name: String): String =
    File(System.getProperty("passholder.repoRoot"), "core/test-vectors/transfer/$name").readText()

/** Reads a `*.expected.json` vector (entries + skipped) the way the importers' result is compared. */
internal fun readExpected(name: String): ParsedImport {
    val o = Json.parseToJsonElement(readVector(name)) as JsonObject
    return ParsedImport(
        (o["entries"] as JsonArray).map(EntryCodec::parseContent),
        (o["skipped"] as JsonArray).map {
            val s = it as JsonObject
            ImportSkip(s["at"]!!.jsonPrimitive.content, s["reason"]!!.jsonPrimitive.content)
        },
    )
}
