/**
 * Minimal Borsh codec for the parts of the chain's wire format the
 * SDK touches today.
 *
 * Borsh is a deterministic, compact, schema-less binary encoding.
 * Spec: https://borsh.io/. The chain serialises transactions with
 * `borsh::to_vec`; this module reproduces just enough of that to
 * encode a `Transaction::V0(Version0)` for `bank.transfer`.
 *
 * Why hand-roll instead of pulling a borsh-ts library: the chain's
 * wire format involves enum discriminants for nested enums (e.g.
 * `RuntimeCall::Bank(BankCall::Transfer { ... })`), which most
 * borsh-ts libraries handle via verbose schema declarations.
 * Hand-rolling the small surface keeps the SDK dependency-light and
 * makes the encoding intent obvious in code review.
 *
 * Numeric layout (little-endian for all):
 * - `u32` → 4 bytes
 * - `u64` → 8 bytes
 * - `u128` → 16 bytes
 * - `bool` → 1 byte (0 or 1)
 * - `Vec<u8>` → 4-byte LE length + payload bytes
 * - `Option<T>` → 1-byte discriminant (0 = None, 1 = Some) + Some(T)
 * - enum variant → 1-byte discriminant + variant payload
 */

/** A simple write-end-ed buffer for borsh encoding. */
export class BorshWriter {
  private buf: number[] = []

  bytes(): Uint8Array {
    return Uint8Array.from(this.buf)
  }

  writeByte(v: number): void {
    this.buf.push(v & 0xff)
  }

  writeBytes(bytes: Uint8Array): void {
    for (const b of bytes) this.buf.push(b)
  }

  writeU8(v: number): void {
    this.writeByte(v)
  }

  writeU32(v: number): void {
    if (v < 0 || v > 0xffffffff) {
      throw new Error(`u32 out of range: ${v}`)
    }
    // Little-endian.
    this.writeByte(v)
    this.writeByte(v >>> 8)
    this.writeByte(v >>> 16)
    this.writeByte(v >>> 24)
  }

  writeU64(v: bigint): void {
    if (v < 0n || v > 0xffffffff_ffffffffn) {
      throw new Error(`u64 out of range: ${v}`)
    }
    // Little-endian.
    for (let i = 0; i < 8; i++) {
      this.writeByte(Number((v >> BigInt(i * 8)) & 0xffn))
    }
  }

  writeU128(v: bigint): void {
    if (v < 0n || v > 0xffffffff_ffffffff_ffffffff_ffffffffn) {
      throw new Error(`u128 out of range: ${v}`)
    }
    // Little-endian.
    for (let i = 0; i < 16; i++) {
      this.writeByte(Number((v >> BigInt(i * 8)) & 0xffn))
    }
  }

  /** Borsh-encode a `Vec<u8>`: 4-byte LE length + bytes. */
  writeVecU8(bytes: Uint8Array): void {
    this.writeU32(bytes.length)
    this.writeBytes(bytes)
  }

  /** Borsh-encode an `Option<T>` discriminant. The caller writes T's payload after if Some. */
  writeOptionTag(some: boolean): void {
    this.writeByte(some ? 1 : 0)
  }

  /** Borsh-encode a fixed-size byte array: just the bytes, no length. */
  writeFixedBytes(bytes: Uint8Array, expectedLen: number): void {
    if (bytes.length !== expectedLen) {
      throw new Error(`expected ${expectedLen}-byte fixed array, got ${bytes.length}`)
    }
    this.writeBytes(bytes)
  }
}
