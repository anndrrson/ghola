//! Best-effort audit tests for zeroize semantics.
//!
//! Under stable Rust we cannot observe freed memory with full reliability
//! — the allocator may have already reused / overwritten the page, the
//! compiler may have elided the zeroize store, and any test we write is
//! technically UB the moment we dereference a freed pointer.
//!
//! What we CAN test:
//!
//! 1. The visible state of the value just before drop is what we expect.
//! 2. A `Zeroizing<[u8;N]>` mutates to all-zero when dropped IF we
//!    inspect it via `read_volatile` on the same address before the
//!    allocator hands the page out (best-effort; some tests below).
//! 3. The `Debug` impl never emits secret content (this is reliable).
//! 4. Equality is value-correct (constant-time property is documented
//!    in the unit test inside `lib.rs`).
//!
//! These tests document intent. They are NOT a substitute for a formal
//! audit of the assembly produced by `rustc` on the target platform.

use common_secrets::{ScrubbedString, SecretBytes};

#[test]
fn secret_bytes_debug_never_leaks() {
    let s = SecretBytes::<32>::new([0x42; 32]);
    let d = format!("{s:?}");
    assert!(!d.contains("42"));
    assert!(d.contains("redacted"));
}

#[test]
fn scrubbed_string_only_shows_prefix() {
    let mut bytes = [0u8; 32];
    bytes[0] = 0xFF;
    bytes[1] = 0xEE;
    bytes[2] = 0xDD;
    bytes[3] = 0xCC;
    bytes[31] = 0xAB; // sensitive — must not appear
    let s = SecretBytes::<32>::new(bytes);
    let tag = ScrubbedString::from_secret(&s);
    let out = tag.to_string();
    assert!(out.starts_with("ffeedd"));
    assert!(!out.contains("ab"));
}

#[test]
fn equality_is_value_correct_for_audit_record() {
    let a = SecretBytes::<32>::new([7u8; 32]);
    let b = SecretBytes::<32>::new([7u8; 32]);
    let mut c_bytes = [7u8; 32];
    c_bytes[31] = 8;
    let c = SecretBytes::<32>::new(c_bytes);
    assert_eq!(a, b);
    assert_ne!(a, c);
}

/// Inspect a `SecretBytes` immediately after it goes out of scope by
/// retaining a raw pointer to its backing memory. This is technically
/// undefined behavior — we use `read_volatile` to discourage the
/// compiler from optimizing the read away, but the allocator may
/// have overwritten the page, in which case the test still passes
/// (zeros are zeros either way).
///
/// Marked `#[ignore]` because the result is non-deterministic across
/// platforms / allocators. Documents the intent.
#[test]
#[ignore = "best-effort, allocator-dependent; documents zeroize-on-drop intent"]
fn secret_bytes_zeroized_on_drop_best_effort() {
    let ptr: *const u8;
    {
        let s = SecretBytes::<32>::new([0xCD; 32]);
        ptr = s.expose_secret().as_ptr();
        // Ensure ptr is real and content matches before drop.
        let observed = unsafe { core::ptr::read_volatile(ptr) };
        assert_eq!(observed, 0xCD);
    } // drop runs here

    // Race condition: the allocator may have already reused this page.
    // We accept any of:
    //   - 0x00 (zeroize ran and the page is still mapped to us)
    //   - some non-0xCD value (allocator reused the page)
    // We must NOT observe 0xCD (would indicate zeroize never ran).
    let after = unsafe { core::ptr::read_volatile(ptr) };
    assert_ne!(
        after, 0xCD,
        "secret bytes were not zeroized on drop (or page was leaked back)"
    );
}

/// Same intent for `Zeroizing<Vec<u8>>` — the std-allocator wrapper
/// used by the relayer + forester keypair caches.
#[test]
#[ignore = "best-effort, allocator-dependent"]
fn zeroizing_vec_zeroized_on_drop_best_effort() {
    use zeroize::Zeroizing;
    let ptr: *const u8;
    {
        let v = Zeroizing::new(vec![0xCDu8; 64]);
        ptr = v.as_ptr();
        let observed = unsafe { core::ptr::read_volatile(ptr) };
        assert_eq!(observed, 0xCD);
    }
    let after = unsafe { core::ptr::read_volatile(ptr) };
    assert_ne!(after, 0xCD);
}
