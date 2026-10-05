use slot_clock::{controlled, SlotClock, SystemTimeSlotClock};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::Duration;
use types::Slot;

fn request(port: u16, path: &str) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    write!(stream, "POST {} HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n", path).unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    response
}

#[tokio::test]
async fn protocol_time_waits_for_completion_and_rejects_invalid_commands() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    // This isolated test sets its environment before starting the clock/server threads.
    // set_var requires unsafe in Rust 2024 (Gloas); the block also compiles on Pectra.
    unsafe {
        std::env::set_var("PANDA_CLOCK_START_MS", "2000000000000");
        std::env::set_var("PANDA_CLOCK_PORT", port.to_string());
    }
    let clock = SystemTimeSlotClock::new(Slot::new(0), Duration::from_secs(2_000_000_000), Duration::from_secs(12));
    assert_eq!(clock.now(), Some(Slot::new(0)));
    let unix_deadline = Duration::from_secs(2_000_000_012);
    let absolute_deadline = controlled::instant_at(unix_deadline).unwrap();
    let wait = controlled::sleep(Duration::from_secs(12));
    tokio::pin!(wait);
    assert!(tokio::time::timeout(Duration::from_millis(20), &mut wait).await.is_err());
    assert_eq!(clock.now(), Some(Slot::new(0)));
    let response = tokio::task::spawn_blocking(move || request(port, "/advance/2000000012000")).await.unwrap();
    assert!(response.contains("200 OK"));
    tokio::time::timeout(Duration::from_millis(100), &mut wait).await.unwrap();
    assert_eq!(clock.now(), Some(Slot::new(1)));
    // The fixed nonzero origin must not rebase a deadline as protocol time advances.
    assert_eq!(controlled::instant_at(unix_deadline), Some(absolute_deadline));
    tokio::time::timeout(Duration::from_millis(100), controlled::sleep_until(absolute_deadline)).await.unwrap();
    let response = tokio::task::spawn_blocking(move || request(port, "/advance/2000000000000")).await.unwrap();
    assert!(response.contains("409 Conflict"));
    assert_eq!(clock.now(), Some(Slot::new(1)));
    // Waiting for actual work uses a notification, not a polling delay or advancing time.
    let pending = tokio::task::spawn_blocking(move || request(port, "/wait/1/1000/proposal,execution"));
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(!pending.is_finished(), "wait returned before either completion mark");
    controlled::mark("proposal", 1);
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(!pending.is_finished(), "wait returned before all completion marks");
    controlled::mark("execution", 1);
    let response = tokio::time::timeout(Duration::from_millis(100), pending).await.unwrap().unwrap();
    assert!(response.contains("200 OK"));
    assert_eq!(clock.now(), Some(Slot::new(1)));
    // Already completed work must not miss a wakeup.
    let response = tokio::task::spawn_blocking(move || request(port, "/wait/1/1000/proposal,execution")).await.unwrap();
    assert!(response.contains("200 OK"));
    // A missing mark expires in real time while protocol time remains frozen.
    let started = std::time::Instant::now();
    let response = tokio::task::spawn_blocking(move || request(port, "/wait/1/30/missing")).await.unwrap();
    assert!(response.contains("408 Request Timeout"));
    assert!(started.elapsed() >= Duration::from_millis(25));
    assert!(started.elapsed() < Duration::from_secs(1));
    assert_eq!(clock.now(), Some(Slot::new(1)));
    // A later watermark cannot prove the requested phase was observed by the controller.
    controlled::mark_root("sync_contributions", "0xaaa", 1);
    controlled::mark_root("sync_contributions", "0xbbb", 1);
    let response = tokio::task::spawn_blocking(move || request(port, "/wait/1/30/sync_contributions_0xaaa")).await.unwrap();
    assert!(response.contains("408 Request Timeout"));
    assert!(!response.contains("sync_contributions_0xaaa"), "obsolete roots must be evicted");
    let response = tokio::task::spawn_blocking(move || request(port, "/wait/1/30/sync_contributions_0xbbb")).await.unwrap();
    assert!(response.contains("200 OK"));
    controlled::mark("proposal", 2);
    let response = tokio::task::spawn_blocking(move || request(port, "/wait/1/30/proposal")).await.unwrap();
    assert!(response.contains("409 Conflict"));
    for path in ["/wait/1/0/proposal", "/wait/1/30001/proposal", "/wait/1/30/", "/wait/1/30/a%22b"] {
        let response = tokio::task::spawn_blocking(move || request(port, path)).await.unwrap();
        assert!(response.contains("400 Bad Request"));
    }
    // A late subscriber sees the current time; a zero-delay retry waits rather than spinning.
    assert!(tokio::time::timeout(Duration::from_millis(20), controlled::sleep(Duration::ZERO)).await.is_err());
}
