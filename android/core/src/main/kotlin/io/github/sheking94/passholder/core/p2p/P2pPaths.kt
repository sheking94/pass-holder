package io.github.sheking94.passholder.core.p2p

/** HTTP paths of the phone host. TS twin: the P2P_*_PATH constants in core/src/p2p/transport.ts. */
object P2pPaths {
    const val HANDSHAKE = "/p2p/v2/handshake"
    const val SYNC = "/p2p/v2/sync"
    const val FILE = "/p2p/v2/file"

    // Pairing still speaks v1: only the sync protocol moved to v2.
    const val PING = "/p2p/v1/ping"
    const val PAIR_HELLO = "/p2p/v1/pair/hello"
    const val PAIR_START = "/p2p/v1/pair/start"
    const val PAIR_FINISH = "/p2p/v1/pair/finish"

    /** Paths of the removed v1 sync protocol; the host answers them with 410 so old clients ask for an update. */
    const val LEGACY_HANDSHAKE = "/p2p/v1/handshake"
    const val LEGACY_SYNC = "/p2p/v1/sync"
}
