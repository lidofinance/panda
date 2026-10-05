//! Isolate the process-global production protocol clock for each deadline regression.
use slot_clock::ManualSlotClock;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::Duration;

pub fn child(name: &str) -> bool {
    if std::env::var("PANDA_PTC_DEADLINE_CHILD").as_deref() == Ok(name) {
        assert_eq!(slot_clock::controlled::now(), Some(Duration::ZERO));
        return false;
    }
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", name, "--nocapture"])
        .env("PANDA_PTC_DEADLINE_CHILD", name)
        .env("PANDA_CLOCK_START_MS", "0")
        .env("PANDA_CLOCK_PORT", port.to_string())
        .env_remove("PANDA_CLOCK_PARKED")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed; 0 failed"));
    true
}

pub fn request(method: &str, path: &str) -> String {
    let port: u16 = std::env::var("PANDA_CLOCK_PORT").unwrap().parse().unwrap();
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    write!(
        stream,
        "{method} {path} HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n"
    )
    .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    response
}

pub async fn advance(clock: &ManualSlotClock, duration: Duration) {
    clock.advance_time(duration);
    let now = slot_clock::controlled::now().unwrap() + duration;
    request("POST", &format!("/advance/{}", now.as_millis()));
    tokio::task::yield_now().await;
}
