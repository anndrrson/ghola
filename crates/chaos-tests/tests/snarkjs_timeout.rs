//! Scenario: snarkjs subprocess hangs -> tokio timeout fires + child killed.
//!
//! Stream 5 owns the production implementation (the `tokio::time::timeout`
//! wrapper inside `said-shielded-pool-prover/src/backend/snarkjs.rs`). From
//! the chaos-test side we exercise the same behaviour against a synthetic
//! child process so the test runs without depending on a real snarkjs
//! installation. If Stream 5 changes the env-var name we'll need to keep
//! this test in sync.
//!
//! The test is marked `#[ignore]` because it shells out (`/bin/sh` +
//! `sleep`) and we don't want it firing as part of the default unit-test
//! run on minimal CI images. Invoke with:
//!
//! ```text
//! cargo test -p chaos-tests --test snarkjs_timeout -- --ignored
//! ```

use std::time::{Duration, Instant};

use tokio::process::Command;

/// What the chaos test asserts:
///   - `tokio::time::timeout` fires before the child completes.
///   - The child PID is no longer alive after `kill_on_drop` takes effect.
///
/// This mirrors what the production prover does in
/// `backend::snarkjs::prove_with_timeout`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "shells out to /bin/sh; opt-in via --ignored"]
async fn snarkjs_subprocess_killed_on_timeout() {
    let mut cmd = Command::new("/bin/sh");
    cmd.arg("-c").arg("sleep 30");
    cmd.kill_on_drop(true);

    let mut child = cmd.spawn().expect("spawn child");
    let pid = child.id().expect("child has pid");

    let started = Instant::now();
    let res = tokio::time::timeout(Duration::from_millis(200), child.wait()).await;
    let elapsed = started.elapsed();

    assert!(res.is_err(), "child must NOT complete before timeout fires");
    assert!(
        elapsed < Duration::from_secs(1),
        "timeout should fire near deadline; took {elapsed:?}"
    );

    // Drop child -> kill_on_drop kicks in. Give the OS a moment to reap.
    drop(child);
    tokio::time::sleep(Duration::from_millis(200)).await;

    // `kill -0 <pid>` returns 0 iff the process exists AND we have
    // permission. On macOS / Linux a defunct (reaped) PID will return
    // ESRCH. We tolerate either "no such process" or "permission denied"
    // — the latter happens if the PID has been recycled.
    let still_alive = unsafe { libc_kill_zero(pid as i32) };
    assert!(
        !still_alive,
        "subprocess (pid {pid}) was still alive after timeout drop"
    );
}

// Minimal libc shim so the test doesn't need a `libc` dep.
unsafe fn libc_kill_zero(pid: i32) -> bool {
    // POSIX: `kill(pid, 0)` returns 0 if signal could be sent (process
    // exists). Returns -1 + sets errno=ESRCH if not. We can spawn a
    // small shell to ask the same question portably without linking
    // libc.
    let output = std::process::Command::new("/bin/sh")
        .arg("-c")
        .arg(format!("kill -0 {pid} 2>/dev/null; echo $?"))
        .output();
    let Ok(out) = output else { return false };
    let stdout = String::from_utf8_lossy(&out.stdout);
    let code = stdout.trim().parse::<i32>().unwrap_or(1);
    code == 0
}
