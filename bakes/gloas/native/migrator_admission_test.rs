//! Actual controlled-clock parking must drain queued and requeued database maintenance.
#[path = "../src/panda_migrator_admission.rs"]
mod admission;

use slot_clock::controlled;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::Duration;

fn request(port: u16, path: &str) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    write!(
        stream,
        "POST {path} HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n"
    )
    .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    response
}

#[tokio::test]
async fn checkpoint_drains_queued_coalesced_and_requeued_migrations() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    unsafe {
        std::env::set_var("PANDA_CLOCK_START_MS", "2000000000000");
        std::env::set_var("PANDA_CLOCK_PORT", port.to_string());
    }
    let original_time = controlled::now();
    let (sender, receiver) = admission::channel();
    sender.send(1).unwrap();
    sender.send(2).unwrap();
    let parking = tokio::task::spawn_blocking(move || request(port, "/park"));
    tokio::time::sleep(Duration::from_millis(30)).await;
    let acknowledged_queued = parking.is_finished();
    let first = receiver.recv().unwrap();
    let second = receiver.recv().unwrap();
    assert_eq!((first.value, second.value), (1, 2));
    // Coalescing two maintenance notifications must retain their ownership until work finishes.
    drop(first.guard);
    tokio::time::sleep(Duration::from_millis(30)).await;
    let acknowledged_batch = parking.is_finished();
    // Reconstruction may requeue itself while park has closed fresh public admission.
    sender.send(3).unwrap();
    drop(second.guard);
    tokio::time::sleep(Duration::from_millis(30)).await;
    let acknowledged_requeued = parking.is_finished();
    let third = receiver.recv().unwrap();
    assert_eq!(third.value, 3);
    drop(third.guard);
    assert!(parking.await.unwrap().contains("200 OK"));
    assert!(
        !acknowledged_queued,
        "checkpoint passed pending migration queue"
    );
    assert!(
        !acknowledged_batch,
        "checkpoint passed unfinished coalesced migration"
    );
    assert!(
        !acknowledged_requeued,
        "checkpoint passed requeued reconstruction"
    );
    assert!(controlled::is_quiescent());
    assert_eq!(controlled::now(), original_time);

    assert!(
        tokio::task::spawn_blocking(move || request(port, "/resume"))
            .await
            .unwrap()
            .contains("200 OK")
    );
    // Canceling a disconnected worker releases queued work; failed send returns its notification.
    sender.send(4).unwrap();
    drop(receiver);
    assert_eq!(sender.send(5).unwrap_err().0, 5);
    assert!(
        tokio::task::spawn_blocking(move || request(port, "/park"))
            .await
            .unwrap()
            .contains("200 OK")
    );
    assert!(controlled::is_quiescent());
}
