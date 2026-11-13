package io.github.sheking94.passholder.app

private const val KIB = 1024L
private const val MIB = 1024L * 1024L

/** "472 KB" (at least 1 KB) below 1 MiB, otherwise "4,6 MB" with a decimal comma; base 1024, halves round up. */
fun formatSize(bytes: Long): String {
    if (bytes < MIB) return "${maxOf(1L, (bytes + KIB / 2) / KIB)} KB"
    val tenths = (bytes * 10 + MIB / 2) / MIB
    return "${tenths / 10},${tenths % 10} MB"
}
