# kotlinx.serialization keeps what it needs through its own consumer rules.
# Bouncy Castle: only the Argon2 generator is used, R8 drops the rest.
-dontwarn org.bouncycastle.**
