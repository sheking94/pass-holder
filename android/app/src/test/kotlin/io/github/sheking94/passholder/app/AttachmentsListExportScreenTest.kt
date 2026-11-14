package io.github.sheking94.passholder.app

import io.github.sheking94.passholder.core.Encoding
import io.github.sheking94.passholder.core.files.Attachment
import io.github.sheking94.passholder.core.p2p.EntryContentV3
import io.github.sheking94.passholder.core.p2p.LoginFields
import org.junit.Assert.assertTrue
import org.junit.Test

private fun file(n: Int) = Attachment(
    id = "00000000-0000-4000-8000-00000000000$n",
    name = "plik$n.pdf",
    mime = "application/pdf",
    size = 10,
    chunks = 1,
    sha256 = "0".repeat(64),
    key = Encoding.toBase64(ByteArray(32)),
)

private fun login(name: String, files: Int) =
    EntryContentV3(name, "", LoginFields("jan", "pw"), emptyList(), (1..files).map(::file))

class AttachmentsListScreenTest : ScreenTestBase() {
    @Test
    fun `the list shows the file count next to the name only for entries with files`() {
        createVault()
        putEntry(login("bank.pl", 2))
        putEntry(login("poczta.pl", 0))
        waitFor("bank.pl 📎 2")
        waitFor("poczta.pl")
        assertTrue(gone("poczta.pl 📎"))
    }
}

class AttachmentsExportNoteScreenTest : ScreenTestBase() {
    @Test
    fun `the export screen says JSON and CSV leave the files out and points to the ZIP`() {
        createVault()
        putEntry(login("bank.pl", 1))
        waitFor("bank.pl 📎 1")
        menu("Import i eksport")
        waitFor("1 plik nie zostanie wyeksportowany w formatach JSON i CSV. Wybierz PassHolder ZIP, żeby je zabrać.")
    }
}

class NoExportNoteWithoutFilesScreenTest : ScreenTestBase() {
    @Test
    fun `the export screen has no files note when the vault has none`() {
        createVault()
        putEntry(login("bank.pl", 0))
        waitFor("bank.pl")
        menu("Import i eksport")
        waitFor("Import i eksport")
        assertTrue(gone("nie zostanie wyeksportowany"))
    }
}
