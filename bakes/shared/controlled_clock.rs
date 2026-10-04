//! Devnet-only protocol clock. Real I/O deadlines deliberately remain on tokio::time.
//! Enabled only by PANDA_CLOCK_START_MS and PANDA_CLOCK_PORT. Never use on a public network.
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::watch;
use tokio::time::Instant;

struct Clock {
    time: watch::Sender<u64>,
    start: u64,
    origin: Instant,
    marks: Mutex<BTreeMap<String, u64>>,
    completed: Condvar,
    control: Mutex<Control>,
    idle: Condvar,
}
#[derive(Default)]
struct Control {
    parked: bool,
    active_work: usize,
}

static CLOCK: OnceLock<Option<Clock>> = OnceLock::new();

fn clock() -> Option<&'static Clock> {
    CLOCK.get_or_init(|| {
        let start = std::env::var("PANDA_CLOCK_START_MS").ok()?.parse::<u64>()
            .expect("PANDA_CLOCK_START_MS must be an unsigned integer");
        let port = std::env::var("PANDA_CLOCK_PORT").expect("PANDA_CLOCK_PORT is required")
            .parse::<u16>().expect("invalid clock port");
        // Bind before spawning, so an unavailable control port fails startup immediately.
        let listener = TcpListener::bind(("0.0.0.0", port)).expect("bind devnet clock");
        std::thread::Builder::new().name("panda-clock".into()).spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
                let mut line = String::new();
                if BufReader::new(&stream).read_line(&mut line).is_err() { continue; }
                let Some(clock) = clock() else { return };
                let mut status = "200 OK";
                let parts: Vec<_> = line.split_whitespace().collect();
                match parts.as_slice() {
                    ["GET", "/", _] => (),
                    ["POST", "/park", _] => status = clock.park(),
                    ["POST", "/resume", _] => {
                        clock.control.lock().expect("clock control").parked = false;
                        let now = *clock.time.borrow();
                        clock.time.send_replace(now);
                    }
                    ["POST", path, _] if path.starts_with("/advance/") => {
                        match path.trim_start_matches("/advance/").parse::<u64>() {
                            Ok(next) if !clock.control.lock().expect("clock control").parked && next >= *clock.time.borrow() && next - clock.start < 31_536_000_000_000 => {
                                clock.time.send_replace(next);
                            }
                            _ => status = "409 Conflict",
                        }
                    }
                    ["POST", path, _] if path.starts_with("/wait/") => {
                        status = clock.wait_marks(path.trim_start_matches("/wait/"));
                    }
                    _ => status = "400 Bad Request",
                }
                let now = *clock.time.borrow();
                let marks = clock.marks.lock().expect("clock marks");
                let marks = marks.iter().map(|(k, v)| format!("\"{}\":{}", k, v))
                    .collect::<Vec<_>>().join(",");
                let control = clock.control.lock().expect("clock control");
                let body = format!("{{\"nowMs\":{},\"marks\":{{{}}},\"parked\":{},\"activeWork\":{}}}", now, marks, control.parked, control.active_work);
                drop(control);
                let _ = write!(stream, "HTTP/1.1 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", status, body.len(), body);
            }
        }).expect("spawn devnet clock");
        Some(Clock { time: watch::channel(start).0, start, origin: Instant::now(), marks: Mutex::new(BTreeMap::new()), completed: Condvar::new(), control: Mutex::new(Control { parked: std::env::var("PANDA_CLOCK_PARKED").as_deref() == Ok("1"), active_work: 0 }), idle: Condvar::new() })
    }).as_ref()
}

impl Clock {
    fn park(&self) -> &'static str {
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        let mut control = self.control.lock().expect("clock control");
        control.parked = true;
        while control.active_work != 0 {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                return "408 Request Timeout";
            }
            control = self
                .idle
                .wait_timeout(control, remaining)
                .expect("clock work")
                .0;
        }
        "200 OK"
    }

    fn wait_marks(&self, path: &str) -> &'static str {
        let parts: Vec<_> = path.split('/').collect();
        let [slot, timeout, names] = parts.as_slice() else {
            return "400 Bad Request";
        };
        let (Ok(slot), Ok(timeout)) = (slot.parse::<u64>(), timeout.parse::<u64>()) else {
            return "400 Bad Request";
        };
        if timeout == 0 || timeout > 30_000 || names.len() > 4096 {
            return "400 Bad Request";
        }
        let names: Vec<_> = names.split(',').collect();
        if names.iter().any(|name| {
            name.is_empty()
                || name.len() > 128
                || !name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        }) {
            return "400 Bad Request";
        }
        // A real deadline; pausing protocol time must never suspend an HTTP request forever.
        let deadline = std::time::Instant::now() + Duration::from_millis(timeout);
        let mut marks = self.marks.lock().expect("clock marks");
        loop {
            if names
                .iter()
                .any(|name| marks.get(*name).is_some_and(|value| *value > slot))
            {
                return "409 Conflict";
            }
            if names.iter().all(|name| marks.get(*name) == Some(&slot)) {
                return "200 OK";
            }
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                return "408 Request Timeout";
            }
            // Check and subscribe under the same mutex: completion cannot be lost between them.
            marks = self
                .completed
                .wait_timeout(marks, remaining)
                .expect("clock completion")
                .0;
        }
    }
}

pub fn now() -> Option<Duration> {
    match clock() {
        Some(clock) => Some(Duration::from_millis(*clock.time.borrow())),
        None => SystemTime::now().duration_since(UNIX_EPOCH).ok(),
    }
}

pub fn instant_now() -> Instant {
    match clock() {
        Some(clock) => clock.origin + Duration::from_millis(*clock.time.borrow() - clock.start),
        None => Instant::now(),
    }
}

pub async fn sleep(duration: Duration) {
    // A zero-duration retry must yield until time changes, rather than spin while paused.
    let duration = if clock().is_some() {
        duration.max(Duration::from_millis(1))
    } else {
        duration
    };
    sleep_until(instant_now() + duration).await;
}

pub async fn sleep_until(deadline: Instant) {
    if let Some(clock) = clock() {
        let mut receiver = clock.time.subscribe();
        loop {
            // Subscribe before checking: advances between the check and await cannot be lost.
            let current = *receiver.borrow_and_update();
            if !clock.control.lock().expect("clock control").parked
                && clock.origin + Duration::from_millis(current - clock.start) >= deadline
            {
                break;
            }
            if receiver.changed().await.is_err() {
                break;
            }
        }
    } else {
        tokio::time::sleep_until(deadline).await;
    }
}

/// A completion watermark; control code waits for successful protocol work, not elapsed wall time.
pub fn mark(name: &str, slot: u64) {
    if let Some(clock) = clock() {
        clock
            .marks
            .lock()
            .expect("clock marks")
            .insert(name.into(), slot);
        clock.completed.notify_all();
    }
}

/// Root-bound completion. Retain only the latest root per phase, even across a long warp.
pub fn mark_root(name: &str, root: &str, slot: u64) {
    if let Some(clock) = clock() {
        let prefix = format!("{}_", name);
        let mut marks = clock.marks.lock().expect("clock marks");
        marks.retain(|key, _| !key.starts_with(&prefix));
        marks.insert(format!("{}{}", prefix, root), slot);
        clock.completed.notify_all();
    }
}

/// Parked startup keeps the real saved clock readable while protocol jobs are suspended.
pub fn is_parked() -> bool {
    clock().is_some_and(|clock| clock.control.lock().expect("clock control").parked)
}

pub async fn wait_until_running() {
    if let Some(clock) = clock() {
        let mut receiver = clock.time.subscribe();
        loop {
            receiver.borrow_and_update();
            if !clock.control.lock().expect("clock control").parked {
                return;
            }
            if receiver.changed().await.is_err() {
                return;
            }
        }
    }
}

/// Covers one native job. Do not nest guards: park closes admission before draining active work.
pub struct WorkGuard(Option<&'static Clock>);
impl Drop for WorkGuard {
    fn drop(&mut self) {
        if let Some(clock) = self.0 {
            let mut control = clock.control.lock().expect("clock control");
            control.active_work -= 1;
            clock.idle.notify_all();
        }
    }
}

pub async fn work() -> WorkGuard {
    if let Some(clock) = clock() {
        let mut receiver = clock.time.subscribe();
        loop {
            receiver.borrow_and_update();
            {
                let mut control = clock.control.lock().expect("clock control");
                if !control.parked {
                    control.active_work += 1;
                    return WorkGuard(Some(clock));
                }
            }
            if receiver.changed().await.is_err() {
                break;
            }
        }
    }
    WorkGuard(None)
}

/// Admit an externally triggered native operation without waiting behind maintenance.
pub fn try_work() -> Option<WorkGuard> {
    let Some(clock) = clock() else {
        return Some(WorkGuard(None));
    };
    let mut control = clock.control.lock().expect("clock control");
    if control.parked {
        return None;
    }
    control.active_work += 1;
    Some(WorkGuard(Some(clock)))
}

/// Track a child of already admitted work, including migration queued before API readiness.
/// The caller must register the child before releasing its parent. This bypasses new-work
/// admission so a migrator requeue cannot deadlock behind park while park waits for its parent.
pub fn background_work() -> WorkGuard {
    if let Some(clock) = clock() {
        clock.control.lock().expect("clock control").active_work += 1;
        WorkGuard(Some(clock))
    } else {
        WorkGuard(None)
    }
}

pub fn is_quiescent() -> bool {
    clock().is_some_and(|clock| {
        let control = clock.control.lock().expect("clock control");
        control.parked && control.active_work == 0
    })
}
