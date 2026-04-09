package xyz.ghola.app.solana

/**
 * # Base58
 *
 * Minimal standalone Bitcoin-style Base58 encoder for Solana public keys.
 * Vendored here so the Wallet tab can render the result of an MWA authorize
 * call without pulling in an extra dependency (e.g. `com.solanamobile:rpc-core`)
 * just for one function.
 *
 * This is the canonical reference implementation — iteratively divide the
 * input bytes interpreted as a big-endian base-256 number by 58, emit the
 * remainder as an ALPHABET digit, then preserve any leading zero bytes as
 * leading '1' characters in the output.
 *
 * Performance is not a concern: we encode exactly one 32-byte Solana pubkey
 * per user tap. The implementation allocates a scratch copy of the input so
 * the caller's bytes are not mutated.
 */
object Base58 {
    private const val ALPHABET =
        "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

    fun encode(input: ByteArray): String {
        if (input.isEmpty()) return ""

        // Count leading zero bytes — they become leading '1' characters.
        var zeros = 0
        while (zeros < input.size && input[zeros].toInt() == 0) zeros++

        // Scratch copy so we can mutate it in place while dividing.
        val scratch = input.copyOf()
        // Upper bound on output length: log_58(256) ≈ 1.37, so 2x input is safe.
        val encoded = CharArray(input.size * 2)
        var outputStart = encoded.size

        var startAt = zeros
        while (startAt < scratch.size) {
            val mod = divmod(scratch, startAt, 256, 58)
            if (scratch[startAt].toInt() == 0) startAt++
            encoded[--outputStart] = ALPHABET[mod.toInt() and 0xFF]
        }

        // Skip leading '1's from over-allocation, then prepend one per leading zero.
        while (outputStart < encoded.size && encoded[outputStart] == ALPHABET[0]) {
            outputStart++
        }
        repeat(zeros) { encoded[--outputStart] = ALPHABET[0] }

        return String(encoded, outputStart, encoded.size - outputStart)
    }

    /**
     * In-place base conversion. Divides [number] (big-endian, base [base])
     * starting at index [firstDigit] by [divisor], stores the quotient back
     * in [number], returns the remainder.
     */
    private fun divmod(
        number: ByteArray,
        firstDigit: Int,
        base: Int,
        divisor: Int,
    ): Byte {
        var remainder = 0
        for (i in firstDigit until number.size) {
            val digit = number[i].toInt() and 0xFF
            val temp = remainder * base + digit
            number[i] = (temp / divisor).toByte()
            remainder = temp % divisor
        }
        return remainder.toByte()
    }
}
