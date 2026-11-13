package io.github.sheking94.passholder.app

import org.junit.Assert.assertEquals
import org.junit.Test

/** File sizes shown next to attachments. */
class FileSizeTest {
    @Test
    fun `below 1 MiB in whole KB, at least 1 KB`() {
        assertEquals("472 KB", formatSize(483211))
        assertEquals("1 KB", formatSize(500))
        assertEquals("1 KB", formatSize(1))
    }

    @Test
    fun `from 1 MiB with one decimal and a comma`() {
        assertEquals("4,6 MB", formatSize(4823449))
        assertEquals("1,0 MB", formatSize(1048576))
        assertEquals("10,0 MB", formatSize(10485760))
    }
}
