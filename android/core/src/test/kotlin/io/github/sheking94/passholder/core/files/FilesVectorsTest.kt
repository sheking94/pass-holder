package io.github.sheking94.passholder.core.files

import io.github.sheking94.passholder.core.Encoding
import io.github.sheking94.passholder.core.p2p.EntryCodec
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory
import java.io.File

/** Shared loader of core/test-vectors/files/files.json; later tasks add sections (files, host) to [FilesVectorsTest]. */
internal object FilesVectors {
    val root: JsonObject by lazy {
        Json.parseToJsonElement(
            File(System.getProperty("passholder.repoRoot"), "core/test-vectors/files/files.json").readText(),
        ).jsonObject
    }

    fun section(name: String): JsonArray = root.getValue(name).jsonArray
}

internal fun JsonElement.str(key: String): String = jsonObject.getValue(key).jsonPrimitive.content

internal fun JsonElement.int(key: String): Long = jsonObject.getValue(key).jsonPrimitive.content.toDouble().toLong()

internal fun attachmentOf(v: JsonElement): Attachment =
    Attachment(v.str("id"), v.str("name"), v.str("mime"), v.int("size"), v.int("chunks").toInt(), v.str("sha256"), v.str("key"))

class FilesVectorsTest {
    @Test
    fun limitsMatchVectors() {
        val l = FilesVectors.root.getValue("limits").jsonObject
        fun n(k: String) = l.getValue(k).jsonPrimitive.content.toLong()
        assertEquals(n("MAX_FILE_SIZE"), Attachments.MAX_FILE_SIZE.toLong())
        assertEquals(n("FILE_CHUNK_SIZE"), Attachments.FILE_CHUNK_SIZE.toLong())
        assertEquals(n("MAX_FILE_CHUNKS"), Attachments.MAX_FILE_CHUNKS.toLong())
        assertEquals(n("MAX_FILE_BLOB_LENGTH"), Attachments.MAX_FILE_BLOB_LENGTH.toLong())
        assertEquals(n("MAX_ATTACHMENTS_PER_ENTRY"), Attachments.MAX_ATTACHMENTS_PER_ENTRY.toLong())
        assertEquals(n("MAX_ATTACHMENTS_PARSED"), Attachments.MAX_ATTACHMENTS_PARSED.toLong())
        assertEquals(n("ORPHAN_FILE_AGE_MS"), Attachments.ORPHAN_FILE_AGE_MS)
    }

    @TestFactory
    fun entries() = FilesVectors.section("entries").map { e ->
        DynamicTest.dynamicTest("entry: ${e.str("description")}") {
            val key = Encoding.fromHex(e.str("vaultKey"))
            val id = e.str("id")
            val payload = e.str("payload")
            val data = EntryCodec.parse(Json.parseToJsonElement(payload))
            val canonical = e.jsonObject["canonicalPayload"]?.jsonPrimitive?.contentOrNull ?: payload
            assertEquals(canonical, EntryCodec.serialize(data))
            assertEquals(e.str("blob"), EntryCodec.encryptJson(key, id, payload, Encoding.fromHex(e.str("nonce"))))
            val opened = EntryCodec.parse(EntryCodec.decrypt(key, id, e.str("blob")))
            assertEquals(data, opened)
            assertEquals(Json.parseToJsonElement(canonical), Json.parseToJsonElement(EntryCodec.serialize(opened)))
            e.jsonObject["merge"]?.let { m ->
                val winner = EntryCodec.parse(Json.parseToJsonElement(m.str("winner"))).content.attachments
                val loser = EntryCodec.parse(Json.parseToJsonElement(m.str("loser"))).content.attachments
                assertEquals(data.content.attachments, Attachments.merge(winner, loser))
            }
        }
    }

    @TestFactory
    fun rejected() = FilesVectors.section("rejected").map { r ->
        DynamicTest.dynamicTest("rejected: ${r.str("description")}") {
            val ex = assertThrows(IllegalArgumentException::class.java) {
                EntryCodec.parse(Json.parseToJsonElement(r.str("payload")))
            }
            assertEquals(r.str("error"), ex.message)
        }
    }

    @TestFactory
    fun merge() = FilesVectors.section("merge").map { m ->
        DynamicTest.dynamicTest("merge: ${m.str("description")}") {
            fun list(k: String) = (m.jsonObject[k] as? JsonArray)?.map(::attachmentOf) ?: emptyList() // missing list counts as empty
            assertEquals(list("expected"), Attachments.merge(list("winner"), list("loser")))
        }
    }

    @TestFactory
    fun files() = FilesVectors.section("files").map { f ->
        DynamicTest.dynamicTest("file: ${f.str("description")}") {
            val size = f.int("size").toInt()
            val bytes = f.jsonObject["content"]?.let { Encoding.fromHex(it.jsonPrimitive.content) }
                ?: ByteArray(size) { i -> ((i * 31 + 7) and 0xff).toByte() }
            val nonces = f.jsonObject.getValue("nonces").jsonArray.map { Encoding.fromHex(it.jsonPrimitive.content) }
            val a = attachmentOf(f.jsonObject.getValue("attachment"))
            val enc = FileChunks.encryptFixed(
                bytes,
                f.str("name"),
                f.str("mime"),
                f.str("id"),
                Encoding.fromHex(f.str("key")),
                nonces,
            )
            assertEquals(a, enc.attachment)
            val aads = f.jsonObject.getValue("aads").jsonArray.map { it.jsonPrimitive.content }
            assertEquals(aads, enc.blobs.indices.map { FileChunks.aad(a.id, it, a.chunks) })
            val hashes = f.jsonObject.getValue("blobSha256").jsonArray.map { it.jsonPrimitive.content }
            assertEquals(hashes, enc.blobs.map { Encoding.sha256Hex(it.toByteArray(Charsets.UTF_8)) })
            assertEquals(f.str("lastBlob"), enc.blobs.last())
            f.jsonObject["blobs"]?.let { b ->
                assertEquals(b.jsonArray.map { it.jsonPrimitive.content }, enc.blobs)
            }
            assertArrayEquals(bytes, FileChunks.decrypt(a, enc.blobs))
        }
    }

    @Test
    fun hostSteps() {
        val h = FilesVectors.root.getValue("host").jsonObject
        FileHostSteps.run(MemoryFileStore(), h.str("epoch"), h.int("now"), h.getValue("steps").jsonArray)
    }

    @Test
    fun storageSteps() {
        val h = FilesVectors.root.getValue("host").jsonObject
        val s = h.getValue("storage").jsonObject
        FileHostSteps.run(MemoryFileStore(s.int("capacity")), h.str("epoch"), h.int("now"), s.getValue("steps").jsonArray)
    }

    @Test
    fun orphans() {
        val o = FilesVectors.root.getValue("host").jsonObject.getValue("orphan").jsonObject
        val store = MemoryFileStore()
        val used = mutableSetOf<String>()
        for (f in o.getValue("files").jsonArray) {
            store.put(f.str("id"), 0, 1, "AAAA", f.int("createdAt"))
            if (f.jsonObject.getValue("used").jsonPrimitive.content == "true") used += f.str("id")
        }
        for (c in o.getValue("cases").jsonArray) {
            val expected = c.jsonObject.getValue("expected").jsonArray.map { it.jsonPrimitive.content }.sorted()
            assertEquals(expected, FileHost.orphanIds(store, used, c.int("now")).sorted())
        }
    }
}
