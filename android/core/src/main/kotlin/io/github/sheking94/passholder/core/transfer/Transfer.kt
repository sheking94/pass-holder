package io.github.sheking94.passholder.core.transfer

import io.github.sheking94.passholder.core.p2p.EntryContentV3
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

enum class TransferFormat { PASSHOLDER, BITWARDEN, NORDPASS }

data class ImportFile(val format: TransferFormat, val parsed: ParsedImport)

/** Import format detection and export dispatch; port of core/src/transfer/detect.ts. */
object Transfer {
    /** Recognises the format from the file's content (JSON starts with "{", anything else is read as NordPass CSV) and parses it. */
    fun parseImportFile(text: String): ImportFile {
        val body = (if (text.startsWith("﻿")) text.substring(1) else text).jsTrim()
        if (body == "") throw IllegalArgumentException("Plik jest pusty")
        if (!body.startsWith("{")) return ImportFile(TransferFormat.NORDPASS, NordPassCsv.parse(text))
        val value = try {
            Json.parseToJsonElement(body)
        } catch (_: Exception) {
            throw IllegalArgumentException("Plik JSON jest uszkodzony")
        }
        return when {
            PassHolderJson.isFormat(value) -> ImportFile(TransferFormat.PASSHOLDER, PassHolderJson.parse(body))
            BitwardenJson.isFormat(value) || isEncryptedBitwarden(value) -> ImportFile(TransferFormat.BITWARDEN, BitwardenJson.parse(body))
            else -> throw IllegalArgumentException("Nie rozpoznano pliku: to nie jest eksport PassHolder, Bitwarden ani NordPass")
        }
    }

    /** A Bitwarden encrypted export has no `items` (password-protected: salt + data); BitwardenJson.parse explains why it is refused. */
    private fun isEncryptedBitwarden(value: kotlinx.serialization.json.JsonElement): Boolean {
        val enc = (value as? JsonObject)?.get("encrypted")
        return enc is JsonPrimitive && !enc.isString && enc.content == "true"
    }

    fun exportFile(format: TransferFormat, entries: List<EntryContentV3>): String = when (format) {
        TransferFormat.PASSHOLDER -> PassHolderJson.export(entries)
        TransferFormat.BITWARDEN -> BitwardenJson.export(entries)
        TransferFormat.NORDPASS -> NordPassCsv.export(entries)
    }
}
